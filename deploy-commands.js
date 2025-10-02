import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;
if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID) throw new Error('Set DISCORD_TOKEN, CLIENT_ID, GUILD_ID in .env');

const commands = [
  new SlashCommandBuilder().setName('ping').setDescription('Simple ping test'),
  new SlashCommandBuilder().setName('promo').setDescription('Post the Free Airdrop Cashback promo')
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

(async () => {
  try {
    // (Optional) clear first
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: [] });
    console.log('Cleared existing guild commands.');

    // Re-register
    const result = await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: commands }
    );
    console.log('✅ Registered GUILD commands:', result.map(c => `${c.name}:${c.id}`).join(', '));
  } catch (err) {
    console.error('❌ Deploy failed:', err?.data ?? err);
  }
})();
