import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';

if (!process.env.DISCORD_TOKEN) throw new Error('Missing DISCORD_TOKEN');
if (!process.env.CLIENT_ID) throw new Error('Missing CLIENT_ID');
if (!process.env.GUILD_ID) throw new Error('Missing GUILD_ID (for instant guild deploy)');

const commands = [
  new SlashCommandBuilder().setName('ping').setDescription('Simple ping test'),
  new SlashCommandBuilder().setName('promo').setDescription('Post the Free Airdrop Cashback promo'),
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log('Deploying guild commands to', process.env.GUILD_ID);
    const result = await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands }
    );
    console.log('✅ Registered GUILD commands:', result.map(c => `${c.name}:${c.id}`).join(', '));
  } catch (err) {
    console.error('❌ Deploy failed:', err?.data ?? err);
  }
})();
