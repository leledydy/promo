import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  AttachmentBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionsBitField,
  ChannelType
} from 'discord.js';
import sqlite3 from 'sqlite3';
import cron from 'node-cron';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// === CONFIG ===
const MIN_GAMES_DEFAULT = 10;
const DEPOSIT_REQUIRED_DEFAULT = true;
const BRAND = 'Kripto11';
const SLOGAN = 'Play Smart. Earn Fast.';

const LOGO_PATH = path.join(__dirname, 'assets', 'kripto-logo.png'); // attach if exists
const BANNER_PATH = path.join(__dirname, 'assets', 'banner.png');     // attach if exists

// === DB (SQLite) ===
const db = new sqlite3.Database(path.join(__dirname, 'claims.db'));
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS claims (
    user_id TEXT PRIMARY KEY,
    username TEXT,
    created_at INTEGER,
    status TEXT DEFAULT 'pending'
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`);
});

// === CLIENT ===
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages
  ],
  partials: [Partials.Channel]
});

client.once('clientReady', () => {
  console.log(`Logged in as ${client.user.tag} ✅`);
});


// === Helpers ===
function buildPromoEmbed({ title, subtitle, minGames, depositRequired, bannerURL }) {
  const min = minGames ?? MIN_GAMES_DEFAULT;
  const depositLine = (depositRequired ?? DEPOSIT_REQUIRED_DEFAULT)
    ? `make your **first deposit**`
    : `register your account`;
  const subtitleLine = subtitle || `For New Registered Users • Deposit + Play 10 Games = Get Cashback`;

  const embed = new EmbedBuilder()
    .setColor('#FFD700')
    .setTitle(title || '🎉 FREE AIRDROP CASHBACK 🎉')
    .setDescription(
      `💸 **Exclusive Welcome Promo for New Members!** 💸\n\n` +
      `🔥 Register today, ${depositLine}, and enjoy:\n\n` +
      `✅ **FREE Airdrop Cashback** credited to your wallet\n` +
      `✅ Available after you’ve played a minimum of **${min} games**\n\n` +
      `⚡ **How it works:**\n` +
      `1️⃣ Join & Register\n` +
      `2️⃣ Make a Deposit\n` +
      `3️⃣ Play at least ${min} Games\n` +
      `4️⃣ Press **Claim Cashback** and our team will review 🚀\n\n` +
      `✨ Don’t miss this limited-time event. Start playing, start earning!`
    )
    .setFooter({ text: `${BRAND} • ${SLOGAN}` });

  if (bannerURL) embed.setImage(bannerURL);
  return { embed, subtitleLine };
}

function attachmentsForEmbed({ bannerURL }) {
  const files = [];
  let logoAttachment = null;
  let bannerAttachment = null;

  if (fs.existsSync(LOGO_PATH)) {
    logoAttachment = new AttachmentBuilder(LOGO_PATH);
    files.push(logoAttachment);
  }
  if (!bannerURL && fs.existsSync(BANNER_PATH)) {
    bannerAttachment = new AttachmentBuilder(BANNER_PATH);
    files.push(bannerAttachment);
  }
  return { files, logoAttachment, bannerAttachment };
}

function promoButtons() {
  const registerUrl = process.env.REGISTER_URL || 'https://t.me/kripto11_bot';
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel('🔐 Register')
      .setURL(registerUrl),
    new ButtonBuilder()
      .setCustomId('claim_cashback')
      .setStyle(ButtonStyle.Success)
      .setLabel('💰 Claim Cashback'),
    new ButtonBuilder()
      .setCustomId('view_terms')
      .setStyle(ButtonStyle.Secondary)
      .setLabel('📜 Terms')
  );
}

async function postPromo(interaction, opts) {
  const { channel, title, subtitle, minGames, depositRequired, bannerURL, pingEveryone } = opts;

  const { embed, subtitleLine } = buildPromoEmbed({ title, subtitle, minGames, depositRequired, bannerURL });
  const { files, logoAttachment, bannerAttachment } = attachmentsForEmbed({ bannerURL });

  // Add subtitle as an embed field for clear reading
  embed.addFields({ name: '—', value: `**${subtitleLine}**` });

  if (!bannerURL && bannerAttachment) {
    embed.setImage('attachment://' + path.basename(BANNER_PATH));
  }
  if (logoAttachment) {
    embed.setThumbnail('attachment://' + path.basename(LOGO_PATH));
  }

  const content = pingEveryone ? '@everyone' : undefined;

  const message = await channel.send({
    content,
    embeds: [embed],
    files,
    components: [promoButtons()]
  });

  await interaction.reply({ content: `Promo posted in ${channel}! ✅`, ephemeral: true });

  // Optional: notify support channel
  const supportId = process.env.SUPPORT_CHANNEL_ID;
  if (supportId) {
    const ch = await client.channels.fetch(supportId).catch(() => null);
    if (ch && ch.type === ChannelType.GuildText) {
      ch.send(`📣 Promo posted by **${interaction.user.tag}** in ${channel}. Message ID: ${message.id}`);
    }
  }
}

// === Interactions ===
client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'promo') {
        const title = interaction.options.getString('title') ?? undefined;
        const subtitle = interaction.options.getString('subtitle') ?? undefined;
        const minGames = interaction.options.getInteger('min_games') ?? undefined;
        const depositRequired = interaction.options.getBoolean('deposit_required');
        const bannerURL = interaction.options.getString('banner_url') ?? undefined;
        const pingEveryone = interaction.options.getBoolean('ping_everyone') ?? false;
        const channel = interaction.options.getChannel('channel') || interaction.channel;

        // Permission check
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
          return interaction.reply({ content: 'You need **Manage Server** to run this.', ephemeral: true });
        }

        await postPromo(interaction, { channel, title, subtitle, minGames, depositRequired, bannerURL, pingEveryone });
      }

      if (interaction.commandName === 'claims') {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
          return interaction.reply({ content: 'Admins only.', ephemeral: true });
        }
        db.all(`SELECT * FROM claims WHERE status='pending' ORDER BY created_at ASC LIMIT 25`, [], (err, rows) => {
          if (err) return interaction.reply({ content: 'DB error.', ephemeral: true });
          if (!rows?.length) return interaction.reply({ content: 'No pending claims 🎉', ephemeral: true });
          const list = rows.map(r => `• <@${r.user_id}> — ${new Date(r.created_at).toLocaleString()} — **${r.status}**`).join('\n');
          interaction.reply({ content: `**Pending Claims (max 25):**\n${list}`, ephemeral: true });
        });
      }

      if (interaction.commandName === 'approve' || interaction.commandName === 'reject') {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
          return interaction.reply({ content: 'Admins only.', ephemeral: true });
        }
        const userId = interaction.options.getString('user_id');
        const newStatus = interaction.commandName === 'approve' ? 'approved' : 'rejected';
        db.run(`UPDATE claims SET status=? WHERE user_id=?`, [newStatus, userId], function (err) {
          if (err) return interaction.reply({ content: 'DB error.', ephemeral: true });
          if (this.changes === 0) return interaction.reply({ content: 'No such claim.', ephemeral: true });
          interaction.reply({ content: `Updated claim for <@${userId}> → **${newStatus.toUpperCase()}** ✅`, ephemeral: false });
        });
      }

      if (interaction.commandName === 'autopromo') {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
          return interaction.reply({ content: 'Admins only.', ephemeral: true });
        }
        const enable = interaction.options.getBoolean('enable');
        db.run(`INSERT INTO settings(key, value) VALUES('autopromo','${enable ? '1' : '0'}')
                ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [], (err) => {
          if (err) return interaction.reply({ content: 'DB error.', ephemeral: true });
          interaction.reply({ content: `Auto-promo ${enable ? 'enabled' : 'disabled'} ✅`, ephemeral: false });
        });
      }
    }

    if (interaction.isButton()) {
      if (interaction.customId === 'claim_cashback') {
        const userId = interaction.user.id;
        const username = interaction.user.tag;
        // record claim if not exists
        db.run(
          `INSERT OR IGNORE INTO claims(user_id, username, created_at, status) VALUES(?,?,?, 'pending')`,
          [userId, username, Date.now()],
          (err) => {
            if (err) console.error(err);
          }
        );

        // notify mods
        const supportId = process.env.SUPPORT_CHANNEL_ID;
        if (supportId) {
          const ch = await client.channels.fetch(supportId).catch(() => null);
          if (ch && ch.type === ChannelType.GuildText) {
            ch.send(`📝 **New Cashback Claim:** <@${userId}> (${username}) — please verify deposit + 10 games.`);
          }
        }

        await interaction.reply({
          ephemeral: true,
          content: `✅ Claim received! Our team will verify your **first deposit** and **minimum games played**.\n` +
                   `You’ll be notified once approved. Thanks, ${interaction.user.username}!`
        });
      }

      if (interaction.customId === 'view_terms') {
        await interaction.reply({
          ephemeral: true,
          content:
            `**Promo Terms**\n` +
            `• New registered users only\n` +
            `• First deposit required\n` +
            `• Play at least **${MIN_GAMES_DEFAULT}** games\n` +
            `• 1 cashback airdrop per user\n` +
            `• Abusive/duplicate accounts may be rejected\n` +
            `• Final decision by ${BRAND} team`
        });
      }
    }
  } catch (e) {
    console.error(e);
    if (interaction.isRepliable()) {
      interaction.reply({ content: 'Something went wrong 😅', ephemeral: true }).catch(() => {});
    }
  }
});

// === Auto-promo (optional daily post at 09:00 server time) ===
cron.schedule('0 9 * * *', async () => {
  try {
    // check toggle
    db.get(`SELECT value FROM settings WHERE key='autopromo'`, [], async (err, row) => {
      if (err || !row || row.value !== '1') return;
      const channelId = process.env.PROMO_CHANNEL_ID;
      if (!channelId) return;
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel) return;

      // dummy interaction-like wrapper
      const fake = { reply: async () => {}, user: { tag: 'auto' } };
      await postPromo(
        { reply: async () => {}, user: { tag: 'auto' } },
        { channel, pingEveryone: false }
      );
      console.log('Auto promo posted.');
    });
  } catch (e) {
    console.error('Auto-promo error', e);
  }
});

client.login(process.env.DISCORD_TOKEN);
