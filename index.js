import 'dotenv/config';
import './server.js'; // safe to include; needed only if Railway uses Web service
import cron from 'node-cron';
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ChannelType
} from 'discord.js';

/* ===== ENV / CONFIG ===== */
const token = (process.env.DISCORD_TOKEN || '').trim();
const channelId = (process.env.CHANNEL_ID || '').trim();

// Schedule settings
const cronExpr = (process.env.POST_CRON || '0 9 * * *').trim(); // default: 09:00 daily
const tz = (process.env.TZ || 'UTC').trim();

// Message options
const pingEveryone = String(process.env.PING_EVERYONE || 'false').toLowerCase() === 'true';
const bannerUrl = (process.env.BANNER_URL || '').trim();
const footerText = (process.env.FOOTER_TEXT || 'Kripto11 • Play Smart. Earn Fast.').trim();
const brandColor = parseInt((process.env.BRAND_COLOR || 'FFD700').replace('#', ''), 16);
const minGames = Number(process.env.MIN_GAMES || 10);
const sendOnBoot = String(process.env.SEND_ON_BOOT || 'false').toLowerCase() === 'true';

/* ===== Sanity Guards (catch common mistakes fast) ===== */
if (!token) {
  console.error('❌ Missing DISCORD_TOKEN in env.');
  process.exit(1);
}
if ((token.match(/\./g) || []).length !== 2) {
  console.error('❌ DISCORD_TOKEN format looks wrong (should contain 2 dots). Paste the *Bot Token* exactly, no quotes, no "Bot " prefix.');
  process.exit(1);
}
if (!channelId) {
  console.error('❌ Missing CHANNEL_ID in env.');
  process.exit(1);
}

/* ===== Discord Client ===== */
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('clientReady', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  const guilds = [...client.guilds.cache.values()].map(g => `${g.name} (${g.id})`);
  console.log('• In guilds:', guilds.join(' | ') || 'none');
  console.log(`• Cron "${cronExpr}" TZ="${tz}" → channel ${channelId}`);

  if (sendOnBoot) {
    console.log('▶ SEND_ON_BOOT=true → sending promo now…');
    await sendPromo();
  }
});

function buildPromoEmbed() {
  return new EmbedBuilder()
    .setColor(brandColor)
    .setTitle('🎉 FREE AIRDROP CASHBACK 🎉')
    .setDescription(
      [
        '💸 **Exclusive Welcome Promo for New Members!** 💸',
        '',
        '🔥 Register today, make your **first deposit**, and enjoy:',
        '✅ **FREE Airdrop Cashback** credited to your wallet',
        `✅ Available after you’ve played a minimum of **${minGames} games**`,
        '',
        '⚡ **How it works:**',
        '1️⃣ Join & Register',
        '2️⃣ Make a Deposit',
        `3️⃣ Play at least ${minGames} Games`,
        '4️⃣ Claim **Cashback Airdrop** 🚀',
        '',
        '✨ Don’t miss this limited-time event. Start playing, start earning!'
      ].join('\n')
    )
    .setFooter({ text: footerText })
    .setImage(bannerUrl || null);
}

async function sendPromo() {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || channel.type !== ChannelType.GuildText) {
      console.error('❌ CHANNEL_ID is not a text channel or not accessible.');
      return;
    }
    const embed = buildPromoEmbed();
    const content = pingEveryone ? '@everyone' : undefined;
    await channel.send({ content, embeds: [embed] });
    console.log('✅ Promo sent.');
  } catch (err) {
    console.error('❌ Failed to send promo:', err?.message || err);
  }
}

/* ===== Cron Scheduler ===== */
cron.schedule(cronExpr, () => {
  console.log('⏰ Cron triggered → sending promo…');
  sendPromo();
}, { timezone: tz });

/* ===== Start ===== */
client.login(token).catch(err => {
  console.error('❌ Login failed:', err?.message || err);
  process.exit(1);
});

// Optional graceful shutdown logs
process.on('SIGTERM', () => { console.log('🛑 SIGTERM received'); process.exit(0); });
process.on('SIGINT',  () => { console.log('🛑 SIGINT received');  process.exit(0); });
