import 'dotenv/config';
import cron from 'node-cron';
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ChannelType
} from 'discord.js';

/* =======================
   ENV & SANITY CHECKS
======================= */
const token = (process.env.DISCORD_TOKEN || '').trim();
const channelId = (process.env.CHANNEL_ID || '').trim();
const cronExpr = (process.env.POST_CRON || '0 9 * * *').trim();
const tz = (process.env.TZ || 'UTC').trim();
const pingEveryone = String(process.env.PING_EVERYONE || 'false').toLowerCase() === 'true';
const bannerUrl = (process.env.BANNER_URL || '').trim();
const footerText = (process.env.FOOTER_TEXT || 'Kripto11 • Play Smart. Earn Fast.').trim();
const brandColor = parseInt((process.env.BRAND_COLOR || 'FFD700').replace('#', ''), 16);
const minGames = Number(process.env.MIN_GAMES || 10);

// Basic token format guard (helps catch the TokenInvalid issue early)
if (!token) {
  console.error('❌ Missing DISCORD_TOKEN in .env');
  process.exit(1);
}
if ((token.match(/\./g) || []).length !== 2) {
  console.error('❌ DISCORD_TOKEN format looks wrong (should contain 2 dots). Make sure you pasted the *Bot Token*, not Client ID/Secret, and no quotes.');
  process.exit(1);
}
if (!channelId) {
  console.error('❌ Missing CHANNEL_ID in .env');
  process.exit(1);
}

/* =======================
   CLIENT
======================= */
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('clientReady', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  // Confirm guilds
  const guilds = [...client.guilds.cache.values()].map(g => `${g.name} (${g.id})`);
  console.log('• In guilds:', guilds.join(' | ') || 'none');
  console.log(`• Will post daily using cron "${cronExpr}" with TZ="${tz}" to channel ${channelId}`);
});

/* =======================
   PROMO MESSAGE
======================= */
function buildPromoEmbed() {
  return new EmbedBuilder()
    .setColor(brandColor)
    .setTitle('🎉 FREE AIRDROP CASHBACK 🎉')
    .setDescription(
      [
        '💸 **Exclusive Welcome Promo for New Members!** 💸',
        '',
        `🔥 Register today, make your **first deposit**, and enjoy:`,
        `✅ **FREE Airdrop Cashback** credited to your wallet`,
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

/* =======================
   CRON SCHEDULER
======================= */
cron.schedule(cronExpr, () => {
  console.log('⏰ Cron triggered → sending promo…');
  sendPromo();
}, { timezone: tz });

/* =======================
   START
======================= */
client.login(token).catch(err => {
  console.error('❌ Login failed:', err?.message || err);
  process.exit(1);
});

// Optional: send once on boot (comment out if you only want scheduled posts)
// sendPromo();
