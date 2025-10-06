// index.js — Ticketing + Two-Way Relay + User DM with robust DM fallbacks (discord.js v14)

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
    GatewayIntentBits.MessageContent // reading DM text for relay
  ],
  partials: [Partials.Channel, Partials.Message, Partials.User]
});

// Track pinned panel per guild
const panelMessageIdByGuild = new Map();
// In-memory anchors for admin reply routing
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
    .setFooter({ text: `UID:${user.id}` })
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

      // Talk to Staff/Admin: DM admin + open DM with user (with robust fallbacks)
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
                attachments: []
              })
            ]
          });

          // Anchor for reply routing
          lastAdminPromptMsgIdByUser.set(interaction.user.id, adminMsg.id);

          // --- DM the user (confirm + keep thread) ---
          const confirmEmbed = buildUserConfirmEmbed({
            adminUser,
            message: text,
            guildName: interaction.guild?.name
          });

          let userDmOk = false;
          try {
            await interaction.user.send({ embeds: [confirmEmbed] });
            userDmOk = true;
          } catch (e1) {
            // Try via createDM as a fallback
            try {
              const udm = await interaction.user.createDM();
              await udm.send({ embeds: [confirmEmbed] });
              userDmOk = true;
            } catch (e2) {
              const code = String(e2?.code ?? e1?.code ?? 'UNKNOWN');
              console.warn('User DM failed:', code, e2?.message || e1?.message || e2 || e1);

              // If DMs are disabled for this server (50007), explain how to enable
              if (code === '50007') {
                await interaction.editReply({
                  content: [
                    '✅ Sent your message to the Admin.',
                    '⚠️ I couldn’t DM you. To receive replies in DM, please enable DMs for this server:',
                    '• On desktop: Right-click the server → **Privacy Settings** → enable **Allow direct messages from server members**.',
                    '• Or globally: **User Settings** → **Privacy & Safety** → enable **Allow direct messages from server members** (Server Privacy Defaults).',
                    'Then DM me once, and I’ll keep the thread open.'
                  ].join('\n')
                });
              }
            }
          }

          if (userDmOk) {
            await interaction.editReply({
              content: '✅ Your message was sent to the Admin. I also opened a DM with you — feel free to continue there.'
            });
          } else if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: '✅ Sent to Admin. (Could not DM you — check your DM privacy settings.)', ephemeral: true });
          }
        } catch (e) {
          const code = e?.code ?? e?.status ?? 'UNKNOWN';
          console.error('Admin DM failed:', { code, message: e?.message });

          // Optional: discreet fallback ping in the support channel
          try {
            const support = await getSupportChannel(interaction.guild);
            await support.send({
              content: `🔔 Heads up <@${ADMIN_ID}>: **${interaction.user.tag}** tried to DM you via the support panel but it failed.\n**Message:** ${interaction.fields.getTextInputValue('ts_message').trim()}`
            });
          } catch {}

          // Also try to DM the user with info (may also fail if 50007)
          try {
            await interaction.user.send('⚠️ I couldn’t deliver your message to the admin right now. Please try again later or post in the support channel.');
          } catch {}

          await interaction.editReply({
            content: String(code) === '50007'
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
