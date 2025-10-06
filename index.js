// index.js — Ticketing + Two-Way Relay + User DM with robust fallback (discord.js v14)
// Features:
// - Auto-posts & pins a support panel in SUPPORT_CHANNEL_ID
// - "Report Server Problem" → creates a Forum post in FORUM_CHANNEL_ID
// - "Talk to Staff/Admin" → DMs ADMIN_USER_ID with user's message
//   -> also attempts to DM the user; if DM fails, auto-creates a private support thread with the user
// - Two-way relay: Admin replies (by replying to bot’s DM) → forwarded to the user; user DMs the bot → forwarded to Admin
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

/* ---------- Fallback: DM the user or open a private support thread ---------- */
async function openUserDmOrFallbackThread({
  guild,
  user,
  adminUser,
  supportChannelId,
  confirmEmbed
}) {
  // 1) Try user.send (fast path)
  try {
    await user.send({ embeds: [confirmEmbed] });
    return { mode: 'dm', thread: null };
  } catch (e1) {
    console.warn('user.send failed:', e1?.code, e1?.message);
  }

  // 2) Try createDM + send
  try {
    const udm = await user.createDM();
    await udm.send({ embeds: [confirmEmbed] });
    return { mode: 'dm', thread: null };
  } catch (e2) {
    const code = String(e2?.code ?? 'UNKNOWN');
    console.warn('createDM/send failed:', code, e2?.message);

    // 3) Fallback: create a private thread in SUPPORT_CHANNEL_ID
    try {
      const support = await guild.channels.fetch(supportChannelId);
      if (!support || support.type !== ChannelType.GuildText) throw new Error('Support channel is not a text channel');

      // Requires private threads enabled + bot permissions
      const thread = await support.threads.create({
        name: `support-${user.username}`.slice(0, 90),
        type: ChannelType.PrivateThread,
        invitable: false,
        autoArchiveDuration: 1440
      });

      // Add user and (optionally) admin
      try { await thread.members.add(user.id); } catch (eAddUser) { console.warn('Add user to thread failed:', eAddUser?.code, eAddUser?.message); }
      try { if (adminUser) await thread.members.add(adminUser.id); } catch (eAddAdmin) { console.warn('Add admin to thread failed:', eAddAdmin?.code, eAddAdmin?.message); }

      await thread.send({
        content: `👋 Hi ${user}, I couldn’t DM you (likely privacy settings). Let’s continue here securely.`,
        embeds: [confirmEmbed]
      });

      return { mode: 'thread', thread };
    } catch (e3) {
      console.error('Private thread fallback failed:', e3?.code, e3?.message);
      throw e2; // bubble original DM error
    }
  }
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

      // Talk to Staff/Admin: DM admin + open DM with user (fallback to private thread if DM fails)
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

          // --- Confirm to user: try DM, else fallback to private thread
          const confirmEmbed = buildUserConfirmEmbed({
            adminUser,
            message: text,
            guildName: interaction.guild?.name
          });

          let deliveredWhere = 'dm';
          try {
            const res = await openUserDmOrFallbackThread({
              guild: interaction.guild,
              user: interaction.user,
              adminUser,
              supportChannelId: SUPPORT_CHANNEL_ID,
              confirmEmbed
            });
            deliveredWhere = res.mode; // 'dm' or 'thread'
          } catch (eDM) {
            const code = String(eDM?.code ?? 'UNKNOWN');
            console.warn('All user delivery paths failed:', code, eDM?.message);

            // Optional: notify admin so they follow up in-server
            try {
              const support = await getSupportChannel(interaction.guild);
              await support.send({
                content: `⚠️ Couldn’t DM <@${interaction.user.id}> and couldn’t create a fallback thread automatically.\n**Message they sent:** ${text}`
              });
            } catch {}
          }

          await interaction.editReply({
            content:
              deliveredWhere === 'dm'
                ? '✅ Your message was sent to the Admin. I also opened a DM with you — feel free to continue there.'
                : '✅ Your message was sent to the Admin. I couldn’t DM you, so I opened a **private support thread** with you instead.'
          });
        } catch (e) {
          const code = e?.code ?? e?.status ?? 'UNKNOWN';
          console.error('Admin DM or user notify failed:', { code, message: e?.message });

          // Discreet ping to admin in support channel
          try {
            const support = await getSupportChannel(interaction.guild);
            await support.send({
              content: `🔔 Heads up <@${ADMIN_ID}>: **${interaction.user.tag}** tried to DM you via the support panel but it failed.\n**Message:** ${text}`
            });
          } catch {}

          // Try to DM the user about failure (may still fail)
          try { await interaction.user.send('⚠️ I couldn’t deliver your message to the admin right now. Please try again later or post in the support channel.'); } catch {}

          await interaction.editReply({
            content:
              String(code) === '50007'
                ? '⚠️ I could not DM the Admin (their DMs might be disabled).'
                : `⚠️ DM failed (code: ${code}).`
          });
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
      if (!refId) return; // must reply to the UID-tagged message

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

      const replyEmbed = buildUserFromAdminEmbed({
        adminUser: msg.author,
        message: msg.content?.trim(),
        attachments: [...msg.attachments.values()].map(a => ({ url: a.url }))
      });

      try {
        await targetUser.send({ content: '✉️ You received a reply from the Admin.', embeds: [replyEmbed] });
      } catch (e1) {
        // If user DMs are closed, inform admin so they can follow up in-server
        const code = String(e1?.code ?? 'UNKNOWN');
        console.warn('Forward to user failed:', code, e1?.message || e1);
        if (code === '50007') {
          await msg.channel.send(`⚠️ I can’t DM <@${targetUserId}> (DMs disabled or blocked). Please follow up in the server.`);
        }
      }
      return;
    }

    // 2) USER → ADMIN (user DMs the bot later with follow-ups)
    if (isDm && msg.author.id !== ADMIN_ID) {
      const adminUser = await client.users.fetch(ADMIN_ID, { force: true }).catch(() => null);
      if (!adminUser) return;

      const dm = await adminUser.createDM();
      const attachments = [...msg.attachments.values()].map(a => ({ url: a.url }));

      const anchorMsgId = lastAdminPromptMsgIdByUser.get(msg.author.id);
      if (!anchorMsgId) {
        await dm.send(`📨 New message from **${msg.author.tag}** (via DM).`);
        const anchor = await dm.send({
          embeds: [
            buildAdminInboxEmbed({
              user: msg.author,
              guildName: 'Direct Message',
              message: msg.content?.trim(),
              attachments
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
              attachments
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
