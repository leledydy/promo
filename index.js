// index.js — Minimal ticketing bot (discord.js v14)
// - Autoposts & pins a panel in SUPPORT_CHANNEL_ID
// - "Report Server Problem" → creates a Forum post in FORUM_CHANNEL_ID
// - "Talk to Staff/Admin" → creates a DM with ADMIN_USER_ID and sends the message
// - Uses MessageFlags.Ephemeral (no deprecated 'ephemeral' option)

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
  console.error('❌ Missing env vars: DISCORD_TOKEN, FORUM_CHANNEL_ID, SUPPORT_CHANNEL_ID, ADMIN_USER_ID');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel, Partials.Message]
});

// Keep track of the pinned panel so we can recreate it if deleted
const panelMessageIdByGuild = new Map();

/* ---------- UI Builders ---------- */
function buildPanelEmbed() {
  return new EmbedBuilder()
    .setTitle('🎫 Support & Reports')
    .setDescription([
      'Use the buttons below:',
      '• **Report Server Problem** → creates a **Forum post** for staff.',
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

/* ---------- Channel Helpers ---------- */
async function getForumChannel(guild) {
  const ch = await guild.channels.fetch(FORUM_CHANNEL_ID).catch(() => null);
  if (!ch || ch.type !== ChannelType.GuildForum) throw new Error('FORUM_CHANNEL_ID is not a Forum Channel or not found.');
  return ch;
}
async function getSupportChannel(guild) {
  const ch = await guild.channels.fetch(SUPPORT_CHANNEL_ID).catch(() => null);
  if (!ch || ch.type !== ChannelType.GuildText) throw new Error('SUPPORT_CHANNEL_ID is not a Text Channel or not found.');
  return ch;
}

/* ---------- Ensure Panel Exists & Pinned ---------- */
async function ensurePinnedPanel(guild) {
  const channel = await getSupportChannel(guild);
  const perms = channel.permissionsFor(guild.members.me);
  if (!perms?.has(PermissionsBitField.Flags.SendMessages)) return null;

  // Look for existing panel from this bot
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

  // Post fresh panel
  const sent = await channel.send({ embeds: [buildPanelEmbed()], components: buildPanelButtons() });
  if (perms.has(PermissionsBitField.Flags.ManageMessages)) {
    await sent.pin().catch(() => {});
  }
  panelMessageIdByGuild.set(guild.id, sent.id);
  return sent;
}

/* ---------- Lifecycle ---------- */
client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Logged in as ${c.user.tag}`);
  for (const [, guild] of client.guilds.cache) {
    ensurePinnedPanel(guild).catch(err => console.error(`ensurePinnedPanel(${guild.id}) error:`, err));
  }
});

/* ---------- Interaction Handling ---------- */
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // Buttons → show modals
    if (interaction.isButton()) {
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

    // Modal submissions
    if (interaction.isModalSubmit()) {
      // Forum post creator
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
              `**Details:**`,
              details
            ].join('\n')
          }
        });

        await interaction.editReply({
          content: `✅ Your report has been posted: ${thread.toString() || thread.url}`
        });
        return;
      }

      // DIRECT DM to admin (simple + direct)
      if (interaction.customId === 'modal_talk_staff') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const message = interaction.fields.getTextInputValue('ts_message').trim();

        // Sanitize ADMIN_USER_ID to ensure it's numeric
        const adminId = String(ADMIN_USER_ID).replace(/\D/g, '');

        try {
          const adminUser = await client.users.fetch(adminId, { force: true });
          if (adminUser.bot) {
            await interaction.editReply({ content: '❌ ADMIN_USER_ID is a bot account. Please set a human account ID.' });
            return;
          }

          // Create (or reuse) a DM channel and send a short line + embed
          const dm = await adminUser.createDM();

          await dm.send(`📨 New message from **${interaction.user.tag}** in **${interaction.guild?.name ?? 'Unknown Server'}**.`);
          const dmEmbed = new EmbedBuilder()
            .setTitle('📩 Message for Admin')
            .addFields(
              { name: 'From', value: `${interaction.user} (${interaction.user.tag})` },
              { name: 'Server', value: interaction.guild?.name || 'Unknown' },
              { name: 'Message', value: message || '(no content)' }
            )
            .setTimestamp()
            .setColor(0x5865f2);
          await dm.send({ embeds: [dmEmbed] });

          await interaction.editReply({ content: '✅ Your message was sent directly to the Admin.' });
        } catch (e) {
          const code = e?.code ?? e?.status ?? 'UNKNOWN';
          console.error('Admin DM failed:', { code, message: e?.message });
          // 50007 = Cannot send messages to this user (DMs off or blocked)
          const human =
            String(code) === '50007'
              ? 'I could not DM the Admin (their DMs might be disabled for this server, or the bot is blocked).'
              : `DM failed (code: ${code}).`;
          await interaction.editReply({ content: `⚠️ ${human}` });
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

/* ---------- Auto-Recreate Panel if Deleted ---------- */
client.on(Events.MessageDelete, async (msg) => {
  try {
    if (!msg.guildId) return;
    if (msg.channelId !== SUPPORT_CHANNEL_ID) return;

    const trackedId = panelMessageIdByGuild.get(msg.guildId);
    if (!trackedId || msg.id !== trackedId) return;

    const guild = client.guilds.cache.get(msg.guildId);
    if (!guild) return;

    const recreated = await ensurePinnedPanel(guild);
    if (recreated?.id) panelMessageIdByGuild.set(guild.id, recreated.id);
  } catch (e) {
    console.error('MessageDelete watcher error:', e);
  }
});

/* ---------- Login ---------- */
client.login(DISCORD_TOKEN);
