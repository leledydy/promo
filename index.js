// index.js — Ticketing + Two-way Relay (discord.js v14)
// Panel in SUPPORT_CHANNEL_ID
// - "Report Server Problem" → creates a Forum post in FORUM_CHANNEL_ID
// - "Talk to Staff/Admin" → collects a message and DMs ADMIN_USER_ID
// Two-way relay:
// - Admin replies in DM *using the reply feature* to the bot's "From <user>" message → bot forwards to that user
// - Users can DM the bot later → bot relays to Admin
// Notes:
// - Uses ephemeral:true (correct in v14)
// - Forwards attachments as links
// - In-memory mapping for convenience (resets on restart)

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
  console.error('❌ Missing env vars: DISCORD_TOKEN, FORUM_CHANNEL_ID, SUPPORT_CHANNEL_ID, ADMIN_USER_ID');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent // needed to read DM text content
  ],
  partials: [Partials.Channel, Partials.Message, Partials.User]
});

// Track pinned panel
const panelMessageIdByGuild = new Map();

// Simple in-memory "conversation" cache
// Maps a userId -> last admin DM messageId that presented user's content (helps admin reply without ambiguity)
const lastAdminPromptMsgIdByUser = new Map();

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

/* ---------- Lifecycle ---------- */
client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Logged in as ${c.user.tag}`);
  for (const [, guild] of client.guilds.cache) {
    ensurePinnedPanel(guild).catch(err => console.error(`ensurePinnedPanel(${guild.id}) error:`, err));
  }
});

/* ---------- Helpers: Relay Formatting ---------- */
function buildAdminInboxEmbed({ user, guildName, message, attachments = [] }) {
  const attLines = attachments.map((a, i) => `• [Attachment ${i + 1}](${a.url})`).join('\n');
  return new EmbedBuilder()
    .setTitle('📩 Message for Admin')
    .addFields(
      { name: 'From', value: `${user} (${user.tag})`, inline: false },
      { name: 'Server', value: guildName || 'Unknown', inline: false },
      { name: 'Message', value: message || '(no content)', inline: false },
      ...(attLines ? [{ name: 'Attachments', value: attLines, inline: false }] : [])
    )
    .setFooter({ text: `UID:${user.id}` }) // <-- critical: used to resolve replies
    .setTimestamp()
    .setColor(0x5865f2);
}

function buildUserFromAdminEmbed({ adminUser, message, attachments = [] }) {
  const attLines = attachments.map((a, i) => `• [Attachment ${i + 1}](${a.url})`).join('\n');
  return new EmbedBuilder()
    .setTitle('👨‍✈️ Reply from Admin')
    .addFields(
      { name: 'From', value: `${adminUser} (${adminUser.tag})`, inline: false },
      { name: 'Message', value: message || '(no content)', inline: false },
      ...(attLines ? [{ name: 'Attachments', value: attLines, inline: false }] : [])
    )
    .setTimestamp()
    .setColor(0x2b2d31);
}

function getUidFromEmbedFooter(msg) {
  const emb = msg.embeds?.[0];
  const footerText = emb?.footer?.text || '';
  const m = footerText.match(/UID:(\d{5,})/);
  return m?.[1] || null;
}

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
              `**Details:**`,
              details
            ].join('\n')
          }
        });

        await interaction.editReply({
          content: `✅ Your report has been posted: ${thread?.toString() || thread?.url || '(thread created)'}`
        });
        return;
      }

      // DIRECT DM to admin + record for relay
      if (interaction.customId === 'modal_talk_staff') {
        await interaction.deferReply({ ephemeral: true });

        const text = interaction.fields.getTextInputValue('ts_message').trim();
        const adminId = String(ADMIN_USER_ID).replace(/\D/g, '');

        try {
          const adminUser = await client.users.fetch(adminId, { force: true });
          if (adminUser.bot) {
            await interaction.editReply({ content: '❌ ADMIN_USER_ID is a bot account. Please set a human account ID.' });
            return;
          }

          const dm = await adminUser.createDM();

          // Short line for context
          await dm.send(`📨 New message from **${interaction.user.tag}** in **${interaction.guild?.name ?? 'Unknown Server'}**.`);

          // Send the main embed and remember message id for reply-based routing
          const adminMsg = await dm.send({
            embeds: [
              buildAdminInboxEmbed({
                user: interaction.user,
                guildName: interaction.guild?.name,
                message: text,
                attachments: [] // from modal, none
              })
            ]
          });

          lastAdminPromptMsgIdByUser.set(interaction.user.id, adminMsg.id);

          await interaction.editReply({ content: '✅ Your message was sent directly to the Admin. You can also DM me later to continue the conversation.' });
        } catch (e) {
          const code = e?.code ?? e?.status ?? 'UNKNOWN';
          console.error('Admin DM failed:', { code, message: e?.message });

          const reason = String(code) === '50007'
            ? 'I could not DM the Admin (their DMs might be disabled for this server, or the bot is blocked).'
            : `DM failed (code: ${code}).`;

          // Optional: discreet fallback ping in the support channel
          try {
            const support = await getSupportChannel(interaction.guild);
            await support.send({
              content: `🔔 Heads up <@${adminId}>: **${interaction.user.tag}** tried to DM you via the support panel but it failed.\n**Message:** ${text}`
            });
          } catch {}

          await interaction.editReply({ content: `⚠️ ${reason}` });
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

/* ---------- Two-way Relay via DMs ---------- */
client.on(Events.MessageCreate, async (msg) => {
  try {
    // Ignore bot messages
    if (msg.author.bot) return;

    // 1) ADMIN → USER (admin replies to the bot's prior DM embed)
    // DM channel with admin?
    const isDm = msg.channel?.type === ChannelType.DM;
    if (isDm && msg.author.id === String(ADMIN_USER_ID).replace(/\D/g, '')) {
      // We only act when admin REPLIES to a specific bot message that contained UID
      const refId = msg.reference?.messageId;
      if (!refId) return; // require using the reply feature for disambiguation

      let referenced;
      try { referenced = await msg.channel.messages.fetch(refId); } catch {}
      if (!referenced) return;

      const targetUserId = getUidFromEmbedFooter(referenced);
      if (!targetUserId) return;

      // Forward to the user
      let targetUser;
      try { targetUser = await client.users.fetch(targetUserId, { force: true }); } catch {}
      if (!targetUser) {
        await msg.channel.send(`⚠️ Could not find user ID ${targetUserId}. They may have left or blocked DMs.`);
        return;
      }

      const userDm = await targetUser.createDM();
      const attachmentUrls = [...msg.attachments.values()].map(a => ({ url: a.url }));
      await userDm.send({
        content: `✉️ You received a reply from the Admin.`,
        embeds: [
          buildUserFromAdminEmbed({
            adminUser: msg.author,
            message: msg.content?.trim(),
            attachments: attachmentUrls
          })
        ]
      });

      return;
    }

    // 2) USER → ADMIN (user DMs the bot later with follow-ups)
    if (isDm) {
      // If it's a user (not admin), relay to admin
      if (msg.author.id !== String(ADMIN_USER_ID).replace(/\D/g, '')) {
        const adminUser = await client.users.fetch(String(ADMIN_USER_ID).replace(/\D/g, ''), { force: true }).catch(() => null);
        if (!adminUser) return;

        const dm = await adminUser.createDM();

        // First, a small context line (once per conversation is fine)
        // Then the embed including UID for reply routing
        const attachmentUrls = [...msg.attachments.values()].map(a => ({ url: a.url }));

        // If we already have a "prompt anchor" message for this user, we can thread replies by telling admin to reply to any of those
        const anchorMsgId = lastAdminPromptMsgIdByUser.get(msg.author.id);
        if (!anchorMsgId) {
          // New conversation anchor for this user
          const intro = await dm.send(`📨 New message from **${msg.author.tag}** (via DM).`);
          const anchor = await dm.send({
            embeds: [
              buildAdminInboxEmbed({
                user: msg.author,
                guildName: 'Direct Message',
                message: msg.content?.trim(),
                attachments: attachmentUrls
              })
            ]
          });
          lastAdminPromptMsgIdByUser.set(msg.author.id, anchor.id);
        } else {
          // We still send a new embed so admin can reply specifically to this new item if they wish
          await dm.send({
            embeds: [
              buildAdminInboxEmbed({
                user: msg.author,
                guildName: 'Direct Message',
                message: msg.content?.trim(),
                attachments: attachmentUrls
              })
            ]
          });
        }
      }
    }
  } catch (e) {
    console.error('DM Relay Error:', e);
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
