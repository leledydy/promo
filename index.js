// index.js — Discord ticketing bot (discord.js v14)
// Features:
// - Auto-post & pin a ticket panel in SUPPORT_CHANNEL_ID on startup
// - Auto-recreate the panel if deleted while bot is running
// - "Report Server Problem" → creates a Forum post in FORUM_CHANNEL_ID
// - "Talk to Staff/Admin" → DMs ADMIN_USER_ID directly (no user DMs, no fallbacks)
// - Hardened DM delivery (plain text + embed), explicit diagnostics, anti-spam cooldown
// - Ephemeral replies use MessageFlags.Ephemeral (Discord deprecation fix)
// - Minimal healthcheck HTTP server + graceful shutdown (helps avoid SIGTERM on PaaS)

import 'dotenv/config';
import http from 'node:http';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  ModalBuilder,
  Partials,
  PermissionsBitField,
  TextInputBuilder,
  TextInputStyle
} from 'discord.js';

const {
  DISCORD_TOKEN,
  FORUM_CHANNEL_ID,
  SUPPORT_CHANNEL_ID,
  ADMIN_USER_ID
} = process.env;

if (!DISCORD_TOKEN || !FORUM_CHANNEL_ID || !SUPPORT_CHANNEL_ID || !ADMIN_USER_ID) {
  console.error('❌ Missing required env vars: DISCORD_TOKEN, FORUM_CHANNEL_ID, SUPPORT_CHANNEL_ID, ADMIN_USER_ID');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages // required to DM admin
  ],
  partials: [Partials.Channel, Partials.Message] // Channel for DMs; Message for delete watcher
});

// Track the current panel message per guild (to auto-recreate on deletion)
const panelMessageIdByGuild = new Map(); // guildId -> messageId

// Lightweight anti-spam cooldown for button → modal (ms)
const COOLDOWN_MS = 3000;
const lastInteractAt = new Map(); // key: `${guildId}:${userId}:${customId}` -> timestamp

/* ---------------- UI Builders ---------------- */
function buildPanelEmbed() {
  return new EmbedBuilder()
    .setTitle('🎫 Support & Reports')
    .setDescription([
      'Use the buttons below:',
      '• **Report Server Problem** → creates a **Forum post** for staff to follow up.',
      '• **Talk to Staff/Admin** → sends your message **directly to the Admin’s DMs**.'
    ].join('\n'))
    .setColor(0x2b2d31);
}

function buildPanelButtons() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('btn_report_problem')
        .setLabel('Report Server Problem')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId('btn_talk_staff')
        .setLabel('Talk to Staff/Admin')
        .setStyle(ButtonStyle.Primary)
    )
  ];
}

/* ---------------- Helpers ---------------- */
async function getForumChannel(guild) {
  const ch = await guild.channels.fetch(FORUM_CHANNEL_ID).catch(() => null);
  if (!ch || ch.type !== ChannelType.GuildForum) {
    throw new Error('FORUM_CHANNEL_ID is not a Forum Channel or not found.');
  }
  return ch;
}

async function getSupportChannel(guild) {
  const ch = await guild.channels.fetch(SUPPORT_CHANNEL_ID).catch(() => null);
  if (!ch || ch.type !== ChannelType.GuildText) {
    throw new Error('SUPPORT_CHANNEL_ID is not a Text Channel or not found.');
  }
  return ch;
}

/**
 * Ensure the panel exists & is pinned in SUPPORT_CHANNEL_ID.
 * - Reuses an existing bot panel if present, pins it if needed.
 * - Otherwise posts a fresh one and pins it.
 * - Stores the message ID for deletion tracking.
 */
async function ensurePinnedPanel(guild) {
  const channel = await getSupportChannel(guild);
  const perms = channel.permissionsFor(guild.members.me);
  if (!perms?.has(PermissionsBitField.Flags.SendMessages)) return null;

  const messages = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  const existing = messages?.find(m =>
    m.author.id === guild.members.me.id &&
    m.components?.[0]?.components?.some(c => c.customId === 'btn_report_problem') &&
    m.components?.[0]?.components?.some(c => c.customId === 'btn_talk_staff')
  );

  if (existing) {
    if (!existing.pinned && perms.has(PermissionsBitField.Flags.ManageMessages)) {
      await existing.pin().catch(() => {});
    }
    panelMessageIdByGuild.set(guild.id, existing.id);
    return existing;
  }

  const sent = await channel.send({ embeds: [buildPanelEmbed()], components: buildPanelButtons() });
  if (perms.has(PermissionsBitField.Flags.ManageMessages)) {
    await sent.pin().catch(() => {});
  }
  panelMessageIdByGuild.set(guild.id, sent.id);
  return sent;
}

/* ---------------- Lifecycle ---------------- */
client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Logged in as ${c.user.tag}`);
  // Ensure sticky panel for all guilds on startup
  for (const [, guild] of client.guilds.cache) {
    ensurePinnedPanel(guild).catch(err => console.error(`ensurePinnedPanel(${guild.id}) error:`, err));
  }
});

/* ---------------- Interaction Handlers ---------------- */
function isOnCooldown(key) {
  const now = Date.now();
  const last = lastInteractAt.get(key) ?? 0;
  if (now - last < COOLDOWN_MS) return true;
  lastInteractAt.set(key, now);
  return false;
}

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // Button clicks → show modals
    if (interaction.isButton()) {
      const cooldownKey = `${interaction.guildId}:${interaction.user.id}:${interaction.customId}`;
      if (isOnCooldown(cooldownKey)) {
        try {
          await interaction.reply({ content: '⏳ Please wait a moment before trying again.', flags: MessageFlags.Ephemeral });
        } catch {/* ignore */}
        return;
      }

      // Report Problem -> show modal
      if (interaction.customId === 'btn_report_problem') {
        const titleInput = new TextInputBuilder()
          .setCustomId('rp_title')
          .setLabel('Short Title')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(90)
          .setPlaceholder('e.g., Can’t join server / lag spikes');

        const detailInput = new TextInputBuilder()
          .setCustomId('rp_details')
          .setLabel('Describe the problem')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(1500)
          .setPlaceholder('What happened? When? Any error codes? Steps to reproduce?');

        const reportModal = new ModalBuilder()
          .setCustomId('modal_report_problem')
          .setTitle('Report Server Problem')
          .addComponents(
            new ActionRowBuilder().addComponents(titleInput),
            new ActionRowBuilder().addComponents(detailInput)
          );

        await interaction.showModal(reportModal);
        return;
      }

      // Talk to Staff/Admin -> show modal (later DMs admin)
      if (interaction.customId === 'btn_talk_staff') {
        const msgInput = new TextInputBuilder()
          .setCustomId('ts_message')
          .setLabel('Your message')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(1500)
          .setPlaceholder('Write what you want to tell the admin');

        const talkModal = new ModalBuilder()
          .setCustomId('modal_talk_staff')
          .setTitle('Message Admin / Staff')
          .addComponents(new ActionRowBuilder().addComponents(msgInput));

        await interaction.showModal(talkModal);
        return;
      }
    }

    // Modal submits → process actions
    if (interaction.isModalSubmit()) {
      // Create forum post from report modal
      if (interaction.customId === 'modal_report_problem') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const title = interaction.fields.getTextInputValue('rp_title').trim();
        const details = interaction.fields.getTextInputValue('rp_details').trim();

        const forum = await getForumChannel(interaction.guild);
        const thread = await forum.threads.create({
          name: `${title} — by ${interaction.user.tag}`,
          message: {
            content: [
              `**Reporter:** ${interaction.user} (${interaction.user.tag})`,
              `**Title:** ${title}`,
              `**Details:**\n${details}`
            ].join('\n')
          }
          // If your forum requires tags, add: appliedTags: ['TAG_ID']
        });

        await interaction.editReply({
          content: `✅ Your report has been posted: ${thread.toString() || thread.url}`
        });
        return;
      }

      // DM Admin directly from talk-to-staff modal (robust + diagnostics)
      if (interaction.customId === 'modal_talk_staff') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const message = interaction.fields.getTextInputValue('ts_message').trim();

        const dmEmbed = new EmbedBuilder()
          .setTitle('📩 New Message for Admin')
          .addFields(
            { name: 'From', value: `${interaction.user} (${interaction.user.tag})` },
            { name: 'Server', value: interaction.guild?.name || 'Unknown' },
            { name: 'Message', value: message || '(no content)' }
          )
          .setTimestamp()
          .setColor(0x5865f2);

        let sentOK = true;
        let dmChannelId = null;
        let failureMsg = null;

        try {
          // 1) Fetch admin and validate entity
          const adminUser = await client.users.fetch(ADMIN_USER_ID, { force: true });
          console.log(`[TalkStaff] Target admin resolved:`, {
            id: adminUser.id,
            tag: adminUser.tag,
            bot: adminUser.bot
          });

          if (adminUser.bot) {
            throw new Error('ADMIN_USER_ID points to a bot account. Bots cannot receive DMs from bots.');
          }

          // 2) Create or reuse DM channel explicitly
          const dm = await adminUser.createDM();
          dmChannelId = dm?.id;

          // 3) Send a short text first (surfaces in Requests), then the embed
          await dm.send(`📨 You have a new message from **${interaction.user.tag}** in **${interaction.guild?.name ?? 'Unknown Server'}**.`);
          await dm.send({ embeds: [dmEmbed] });

        } catch (e) {
          sentOK = false;
          const code = e?.code ?? e?.status ?? 'UNKNOWN';
          console.error('Admin DM failed:', { code, message: e?.message, stack: e?.stack });
          if (String(code) === '50007') {
            failureMsg = 'I could not DM the Admin (they likely have DMs disabled for this server, or have blocked the bot).';
          } else if (e?.message?.toLowerCase().includes('bot account')) {
            failureMsg = 'ADMIN_USER_ID points to a bot account. Bots cannot receive DMs.';
          } else {
            failureMsg = `DM failed (code: ${code}).`;
          }
        }

        const replyMsg = sentOK
          ? `✅ Your message was sent to the Admin.\nIf they don’t see it, ask them to check **Inbox → Message Requests**.\nDM channel: \`${dmChannelId ?? 'unknown'}\`.`
          : `⚠️ ${failureMsg} Please verify **ADMIN_USER_ID** and the Admin’s DM privacy settings.`;

        try {
          await interaction.editReply({ content: replyMsg });
        } catch {
          try { await interaction.followUp({ content: replyMsg, flags: MessageFlags.Ephemeral }); } catch {}
        }
        return;
      }
    }
  } catch (err) {
    console.error(err);
    if (interaction.isRepliable()) {
      const msg = err?.message || 'Unexpected error.';
      try { await interaction.reply({ content: `❌ Error: ${msg}`, flags: MessageFlags.Ephemeral }); }
      catch { try { await interaction.editReply({ content: `❌ Error: ${msg}` }); } catch {} }
    }
  }
});

/* ---------------- Auto-Recreate Panel on Delete ---------------- */
client.on(Events.MessageDelete, async (msg) => {
  try {
    if (!msg.guildId) return;                         // ignore DMs
    if (msg.channelId !== SUPPORT_CHANNEL_ID) return; // only care about support channel

    const trackedId = panelMessageIdByGuild.get(msg.guildId);
    if (!trackedId) return;
    if (msg.id !== trackedId) return;                 // only if our tracked panel was deleted

    const guild = client.guilds.cache.get(msg.guildId);
    if (!guild) return;

    const recreated = await ensurePinnedPanel(guild);
    if (recreated?.id) {
      panelMessageIdByGuild.set(guild.id, recreated.id);
    }
  } catch (e) {
    console.error('MessageDelete watcher error:', e);
  }
});

/* ---------------- Minimal healthcheck HTTP server ---------------- */
const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('OK\n');
});
server.listen(PORT, () => {
  console.log(`🌐 Healthcheck server listening on :${PORT}`);
});

// --- graceful shutdown diagnostics
process.on('SIGTERM', () => {
  console.log('⚠️  Received SIGTERM. Closing HTTP server and logging out...');
  server.close(() => console.log('🌐 HTTP server closed.'));
  client.destroy();
  process.exit(0);
});
process.on('SIGINT', () => {
  console.log('⚠️  Received SIGINT. Closing...');
  server.close(() => console.log('🌐 HTTP server closed.'));
  client.destroy();
  process.exit(0);
});

/* ---------------- Login ---------------- */
client.login(DISCORD_TOKEN);
