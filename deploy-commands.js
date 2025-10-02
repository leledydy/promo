import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;
if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID) {
  throw new Error('Set DISCORD_TOKEN, CLIENT_ID, and GUILD_ID in .env');
}

const commands = [
  new SlashCommandBuilder()
    .setName('promo')
    .setDescription('Post the Free Airdrop Cashback promo embed')
    .addStringOption(o => o.setName('title').setDescription('Custom title'))
    .addStringOption(o => o.setName('subtitle').setDescription('Custom subtitle line'))
    .addIntegerOption(o => o.setName('min_games').setDescription('Minimum games required'))
    .addBooleanOption(o => o.setName('deposit_required').setDescription('Require first deposit?'))
    .addChannelOption(o => o.setName('channel').setDescription('Channel to post into'))
    .addStringOption(o => o.setName('banner_url').setDescription('Banner image URL'))
    .addBooleanOption(o => o.setName('ping_everyone').setDescription('Tag @everyone')),
  new SlashCommandBuilder()
    .setName('claims')
    .setDescription('Admin: list pending cashback claims'),
  new SlashCommandBuilder()
    .setName('approve')
    .setDescription('Admin: approve a claim by user ID')
    .addStringOption(o => o.setName('user_id').setDescription('Discord user ID').setRequired(true)),
  new SlashCommandBuilder()
    .setName('reject')
    .setDescription('Admin: reject a claim by user ID')
    .addStringOption(o => o.setName('user_id').setDescription('Discord user ID').setRequired(true)),
  new SlashCommandBuilder()
    .setName('autopromo')
    .setDescription('Admin: enable/disable daily auto-post at 09:00 (server time)')
    .addBooleanOption(o => o.setName('enable').setDescription('Enable or disable').setRequired(true)),
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

(async () => {
  try {
    // Clear then (re)register to ensure a clean state
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: [] });
    console.log('🧹 Cleared existing guild commands.');

    const result = await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: commands }
    );
    console.log('✅ Registered GUILD commands:', result.map(c => `${c.name}:${c.id}`).join(', '));
    console.log('Tip: In Discord, type "/" and you should see: promo, claims, approve, reject, autopromo');
  } catch (err) {
    console.error('❌ Deploy failed:', err?.data ?? err);
  }
})();
