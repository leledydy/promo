// index.js — Discord ticketing bot (discord.js v14)
// Features:
// - Auto-post & pin a ticket panel in SUPPORT_CHANNEL_ID on startup
// - Auto-recreate the panel if deleted while bot is running
// - "Report Server Problem" → creates a Forum post in FORUM_CHANNEL_ID
// - "Talk to Staff/Admin" → DMs ADMIN_USER_ID directly (no user DMs, no fallbacks)

import 'dotenv/config';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
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
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // Button clicks → show modals
    if (interaction.isButton()) {
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
        await interaction.deferReply({ ephemeral: true });

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
        });

        await interaction.editReply({
          content: `✅ Your report has been posted: ${thread.toString() || thread.url}`
        });
        return;
      }

      // DM Admin directly from talk-to-staff modal (robust + guaranteed confirmation)
      if (interaction.customId === 'modal_talk_staff') {
        await interaction.deferReply({ ephemeral: true });

        const message = interaction.fields.getTextInputValue('ts_message').trim();

        // Fetch admin and create a DM channel explicitly
        let adminUser;
        try {
          adminUser = await client.users.fetch(ADMIN_USER_ID, { force: true });
        } catch (e) {
          console.error('Failed to fetch ADMIN_USER_ID:', e);
          try {
            await interaction.editReply({ content: '❌ Could not find the Admin account. Check ADMIN_USER_ID.' });
          } catch {}
          return;
        }

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
        try {
          const dm = await adminUser.createDM();
          await dm.send({ embeds: [dmEmbed] });
        } catch (e) {
          sentOK = false;
          console.error('Admin DM failed:', e);
        }

        const replyMsg = sentOK
          ? '✅ Your message was sent directly to the Admin.'
          : '⚠️ I could not DM the Admin (their DMs might be closed or the ID is wrong).';
        try {
          await interaction.editReply({ content: replyMsg });
        } catch {
          try { await interaction.followUp({ content: replyMsg, ephemeral: true }); } catch {}
        }
        return;
      }
    }
  } catch (err) {
    console.error(err);
    if (interaction.isRepliable()) {
      const msg = err?.message || 'Unexpected error.';
      try { await interaction.reply({ content: `❌ Error: ${msg}`, ephemeral: true }); }
      catch { try { await interaction.editReply({ content: `❌ Error: ${msg}` }); } catch {} }
    }
  }
});

/* ---------------- Auto-Recreate Panel on Delete ---------------- */
client.on(Events.MessageDelete, async (msg) => {
  try {
    if (!msg.guildId) return;                 // ignore DMs
    if (msg.channelId !== SUPPORT_CHANNEL_ID) return; // only care about support channel

    const trackedId = panelMessageIdByGuild.get(msg.guildId);
    if (!trackedId) return;
    if (msg.id !== trackedId) return;         // only if our tracked panel was deleted

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

/* ---------------- Login ---------------- */
client.login(DISCORD_TOKEN);
