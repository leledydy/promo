// index.js — Ticketing + Two-Way Relay + User DM (discord.js v14)
// Features:
// - Auto-posts & pins a support panel in SUPPORT_CHANNEL_ID
// - "Report Server Problem" → creates a Forum post in FORUM_CHANNEL_ID
// - "Talk to Staff/Admin" → DMs ADMIN_USER_ID with user's message AND opens a DM thread with the user
// - Two-way relay: Admin replies (by replying to the bot's DM) → forwarded to the user; user DMs the bot → forwarded to Admin
// - Uses ephemeral:true (v14-correct), forwards attachments as links, in-memory mappings

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

const ADMIN_ID = String(ADMIN_USER_ID).replace(/\D/g, '');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent // needed to read DM text for relay
  ],
  partials: [Partials.Channel, Partials.Message, Partials.User]
});

// Track pinned panel per guild
const panelMessageIdByGuild = new Map();

// Simple in-memory conversation anchors (resets on restart)
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
    .setFooter({ text: `UID:${user.id}` }) // used to route admin replies
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

function buildUserConfirmEmbed({ adminUser, message, guildName }) {
  return new EmbedBuilder()
    .setTitle('✅ Message Sent to Admin')
    .setDescription([
      `Your message has been delivered to ${adminUser}.`,
      `You can continue chatting with me here — I’ll relay everything to the admin and forward their replies back to you.`
    ].join('\n'))
    .addFields(
      { name: 'Server', value: guildName || 'Unknown', inline: false },
      { name: 'Your Message', value: message || '(no content)', inline: false }
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

/* ---------- Interactions ---------- */
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

      // DIRECT DM to admin + record for relay + DM the user (create user thread)
      if (interaction.customId === 'modal_talk_staff') {
        await interaction.deferReply({ ephemeral: true });

        const text = interaction.fields.getTextInputValue('ts_message').trim();

        try {
          const adminUser = await client.users.fetch(ADMIN_ID, { force: true });
          if (adminUser.bot) {
            await interaction.editReply({ content: '❌ ADMIN_USER_ID is a bot account. Please set a human account ID.' });
            return;
          }

          // --- DM the admin ---
          const adminDm = await adminUser.createDM();

          await adminDm.send(`📨 New message from **${interaction.user.tag}** in **${interaction.guild?.name ?? 'Unknown Server'}**.`);
          const adminMsg = await adminDm.send({
            embeds: [
              buildAdminInboxEmbed({
                user: interaction.user,
                guildName: interaction.guild?.name,
                message: text,
                attachments: [] // none from modal
              })
            ]
          });

          // Anchor for reply routing
          lastAdminPromptMsgIdByUser.set(interaction.user.id, adminMsg.id);

          // --- DM the user (open/confirm their DM thread with the bot) ---
          try {
            const userDm = await interaction.user.createDM();
            await userDm.send({
              embeds: [
                buildUserConfirmEmbed({
                  adminUser,
                  message: text,
                  guildName: interaction.guild?.name
                })
              ]
            });
          } catch (udmErr) {
            // user DMs might be off; ignore
            console.warn('User DM failed (confirmation):', udmErr?.code || udmErr?.message || udmErr);
          }

          await interaction.editReply({
            content: '✅ Your message was sent directly to the Admin. I also opened a DM with you — feel free to continue here.'
          });
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
              content: `🔔 Heads up <@${ADMIN_ID}>: **${interaction.user.tag}** tried to DM you via the support panel but it failed.\n**Message:** ${text}`
            });
          } catch {}

          // Also try to DM the user with info
          try {
            const userDm = await interaction.user.createDM();
            await userDm.send(`⚠️ I couldn’t deliver your message to the admin right now. Please try again later or post in the support channel.`);
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
    if (msg.author.bot) return;

    const isDm = msg.channel?.type === ChannelType.DM;

    // 1) ADMIN → USER (admin replies to the bot's prior DM embed)
    if (isDm && msg.author.id === ADMIN_ID) {
      const refId = msg.reference?.messageId;
      if (!refId) return; // require using Discord's "Reply" to a UID-tagged message

      let referenced;
      try { referenced = await msg.channel.messages.fetch(refId); } catch {}
      if (!referenced) return;

      const targetUserId = getUidFromEmbedFooter(referenced);
      if (!targetUserId) return;

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
    if (isDm && msg.author.id !== ADMIN_ID) {
      const adminUser = await client.users.fetch(ADMIN_ID, { force: true }).catch(() => null);
      if (!adminUser) return;

      const dm = await adminUser.createDM();
      const attachmentUrls = [...msg.attachments.values()].map(a => ({ url: a.url }));

      const anchorMsgId = lastAdminPromptMsgIdByUser.get(msg.author.id);
      if (!anchorMsgId) {
        await dm.send(`📨 New message from **${msg.author.tag}** (via DM).`);
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
