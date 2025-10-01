import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';

const commands = [
  new SlashCommandBuilder()
    .setName('promo')
    .setDescription('Post the Free Airdrop Cashback promo embed')
    .addStringOption(o => o.setName('title').setDescription('Custom title').setRequired(false))
    .addStringOption(o => o.setName('subtitle').setDescription('Custom subtitle/line').setRequired(false))
    .addIntegerOption(o => o.setName('min_games').setDescription('Minimum games required').setRequired(false))
    .addBooleanOption(o => o.setName('deposit_required').setDescription('Require first deposit?').setRequired(false))
    .addChannelOption(o => o.setName('channel').setDescription('Channel to post into').setRequired(false))
    .addStringOption(o => o.setName('banner_url').setDescription('Banner image URL (overrides local file)').setRequired(false))
    .addBooleanOption(o => o.setName('ping_everyone').setDescription('Tag @everyone').setRequired(false))
    .toJSON(),
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
    .setDescription('Admin: toggle daily auto-post (09:00 server time)')
    .addBooleanOption(o => o.setName('enable').setDescription('Enable or disable').setRequired(true))
].map(c => c);

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

async function main() {
  const { CLIENT_ID, GUILD_ID } = process.env;
  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log('Registered GUILD commands ✅');
  } else {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('Registered GLOBAL commands (may take up to 1h) ✅');
  }
}
main().catch(console.error);
