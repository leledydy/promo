// index.js — Discord ticketing bot (discord.js v14)
// --------------------------------------------------
// Features:
// - Auto-post & pin ticket panel in SUPPORT_CHANNEL_ID
// - Auto-recreate if deleted
// - "Report Server Problem" → creates a Forum post
// - "Talk to Staff/Admin" → DMs ADMIN_USER_ID directly
// - Hardened DM flow (member.send first, then createDM)
// - Full diagnostics + ID sanitization
// - Ephemeral replies use MessageFlags.Ephemeral
// - Minimal healthcheck web server (avoids SIGTERM)
// --------------------------------------------------

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

const panelMessageIdByGuild = new Map();
const COOLDOWN_MS = 3000;
const lastInteractAt = new Map();

/* ---------- Builders ---------- */
function buildPanelEmbed() {
  return new EmbedBuilder()
    .setTitle('🎫 Support & Reports')
    .setDescription([
      'Use the buttons below:',
      '• **Report Server Problem** → creates a **Forum post**.',
      '• **Talk to Staff/Admin** → sends your message **directly to Admin’s DMs**.'
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

/* ---------- Helpers ---------- */
async function getForumChannel(guild) {
  const ch = await guild.channels.fetch(FORUM_CHANNEL_ID).catch(() => null);
  if (!ch || ch.type !== ChannelType.GuildForum) throw new Error('FORUM_CHANNEL_ID invalid.');
  return ch;
}
async function getSupportChannel(guild) {
  const ch = await guild.channels.fetch(SUPPORT_CHANNEL_ID).catch(() => null);
  if (!ch || ch.type !== ChannelType.GuildText) throw new Error('SUPPORT_CHANNEL_ID invalid.');
  return ch;
}
async function ensurePinnedPanel(guild) {
  const channel = await getSupportChannel(guild);
  const perms = channel.permissionsFor(guild.members.me);
  if (!perms?.has(PermissionsBitField.Flags.SendMessages)) return;

  const msgs = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  const existing = msgs?.find(m =>
    m.author.id === guild.members.me.id &&
    m.components?.[0]?.components?.some(c => c.customId === 'btn_report_problem')
  );
  if (existing) {
    if (!existing.pinned && perms.has(PermissionsBitField.Flags.ManageMessages)) await existing.pin().catch(() => {});
    panelMessageIdByGuild.set(guild.id, existing.id);
    return existing;
  }
  const sent = await channel.send({ embeds: [buildPanelEmbed()], components: buildPanelButtons() });
  if (perms.has(PermissionsBitField.Flags.ManageMessages)) await sent.pin().catch(() => {});
  panelMessageIdByGuild.set(guild.id, sent.id);
  return sent;
}

/* ---------- Lifecycle ---------- */
client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Logged in as ${c.user.tag}`);
  for (const [, g] of client.guilds.cache) ensurePinnedPanel(g).catch(e => console.error(e));
});

/* ---------- Interaction Handler ---------- */
function isOnCooldown(key) {
  const now = Date.now(), last = lastInteractAt.get(key) ?? 0;
  if (now - last < COOLDOWN_MS) return true;
  lastInteractAt.set(key, now);
  return false;
}

client.on(Events.InteractionCreate, async (i) => {
  try {
    /* ----- BUTTONS ----- */
    if (i.isButton()) {
      const key = `${i.guildId}:${i.user.id}:${i.customId}`;
      if (isOnCooldown(key))
        return i.reply({ content: '⏳ Please wait a moment before trying again.', flags: MessageFlags.Ephemeral });

      if (i.customId === 'btn_report_problem') {
        const t = new TextInputBuilder().setCustomId('rp_title').setLabel('Short Title')
          .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(90);
        const d = new TextInputBuilder().setCustomId('rp_details').setLabel('Describe the problem')
          .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1500);
        const m = new ModalBuilder().setCustomId('modal_report_problem').setTitle('Report Server Problem')
          .addComponents(new ActionRowBuilder().addComponents(t), new ActionRowBuilder().addComponents(d));
        return i.showModal(m);
      }
      if (i.customId === 'btn_talk_staff') {
        const msg = new TextInputBuilder().setCustomId('ts_message').setLabel('Your message')
          .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1500);
        const m = new ModalBuilder().setCustomId('modal_talk_staff').setTitle('Message Admin / Staff')
          .addComponents(new ActionRowBuilder().addComponents(msg));
        return i.showModal(m);
      }
    }

    /* ----- MODALS ----- */
    if (i.isModalSubmit()) {
      // --- REPORT PROBLEM ---
      if (i.customId === 'modal_report_problem') {
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        const title = i.fields.getTextInputValue('rp_title').trim();
        const details = i.fields.getTextInputValue('rp_details').trim();
        const forum = await getForumChannel(i.guild);
        const thread = await forum.threads.create({
          name: `${title} — by ${i.user.tag}`,
          message: { content: `**Reporter:** ${i.user}\n**Title:** ${title}\n**Details:**\n${details}` }
        });
        return i.editReply({ content: `✅ Report posted: ${thread.toString()}` });
      }

      // --- TALK TO STAFF ---
      if (i.customId === 'modal_talk_staff') {
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        const msg = i.fields.getTextInputValue('ts_message').trim();
        const adminId = String(ADMIN_USER_ID).replace(/\D/g, '');

        const dmEmbed = new EmbedBuilder()
          .setTitle('📩 New Message for Admin')
          .addFields(
            { name: 'From', value: `${i.user} (${i.user.tag})` },
            { name: 'Server', value: i.guild?.name || 'Unknown' },
            { name: 'Message', value: msg || '(no content)' }
          )
          .setColor(0x5865f2)
          .setTimestamp();

        let sentOK = false, dmChannelId = null, fail = null;

        // Try GuildMember.send first
        try {
          const member = await i.guild?.members.fetch(adminId).catch(() => null);
          if (member) {
            console.log(`[TalkStaff] Attempting GuildMember.send() to ${member.user.tag}`);
            await member.send(`📨 New message from **${i.user.tag}** in **${i.guild?.name}**.`);
            const dmMsg = await member.send({ embeds: [dmEmbed] });
            sentOK = true; dmChannelId = dmMsg.channel?.id ?? null;
          }
        } catch (e) {
          const code = e?.code ?? e?.status ?? 'UNKNOWN';
          console.error('GuildMember.send failed:', { code, message: e?.message });
          if (String(code) === '50007') fail = 'Admin has DMs disabled or blocked bot.';
        }

        // Fallback to User.createDM
        if (!sentOK) {
          try {
            const adminUser = await client.users.fetch(adminId, { force: true });
            if (adminUser.bot) throw new Error('ADMIN_USER_ID is a bot.');
            console.log(`[TalkStaff] Attempting User.createDM().send() to ${adminUser.tag}`);
            const dm = await adminUser.createDM();
            dmChannelId = dm?.id;
            await dm.send(`📨 New message from **${i.user.tag}** in **${i.guild?.name}**.`);
            await dm.send({ embeds: [dmEmbed] });
            sentOK = true;
          } catch (e) {
            const code = e?.code ?? e?.status ?? 'UNKNOWN';
            console.error('User.createDM/send failed:', { code, message: e?.message });
            if (String(code) === '50007') fail = 'Cannot DM Admin (DMs off or blocked).';
            else if (e?.message?.includes('bot')) fail = 'ADMIN_USER_ID is a bot account.';
            else fail = `DM failed (code: ${code}).`;
          }
        }

        const reply = sentOK
          ? `✅ Message sent to Admin.\n(Ask them to check **Inbox → Message Requests**)\nDM channel: \`${dmChannelId ?? 'unknown'}\``
          : `⚠️ ${fail ?? 'DM could not be delivered.'} Please verify ADMIN_USER_ID and Admin’s DM settings.`;
        try { await i.editReply({ content: reply }); }
        catch { await i.followUp({ content: reply, flags: MessageFlags.Ephemeral }); }
      }
    }
  } catch (err) {
    console.error('Interaction error:', err);
    if (i.isRepliable())
      try { await i.reply({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral }); }
      catch { try { await i.editReply({ content: `❌ ${err.message}` }); } catch {} }
  }
});

/* ---------- Auto-Recreate Panel ---------- */
client.on(Events.MessageDelete, async (msg) => {
  if (!msg.guildId || msg.channelId !== SUPPORT_CHANNEL_ID) return;
  const tracked = panelMessageIdByGuild.get(msg.guildId);
  if (msg.id !== tracked) return;
  const guild = client.guilds.cache.get(msg.guildId);
  const recreated = await ensurePinnedPanel(guild);
  if (recreated?.id) panelMessageIdByGuild.set(guild.id, recreated.id);
});

/* ---------- Healthcheck Server ---------- */
const PORT = process.env.PORT || 3000;
const server = http.createServer((_, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('OK\n');
});
server.listen(PORT, () => console.log(`🌐 Healthcheck server listening on :${PORT}`));

process.on('SIGTERM', () => {
  console.log('⚠️  SIGTERM received → shutting down.');
  server.close(() => console.log('🌐 HTTP server closed.'));
  client.destroy();
  process.exit(0);
});
process.on('SIGINT', () => {
  console.log('⚠️  SIGINT received → shutting down.');
  server.close(() => console.log('🌐 HTTP server closed.'));
  client.destroy();
  process.exit(0);
});

/* ---------- Login ---------- */
client.login(DISCORD_TOKEN);
