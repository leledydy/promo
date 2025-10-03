import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('clientReady', () => {
  console.log(`Logged in as ${client.user.tag} ✅`);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'ping') {
    await interaction.reply({ content: '🏓 Pong!', ephemeral: true });
  }

  if (interaction.commandName === 'promo') {
    await interaction.reply({ content: '🎉 Promo command works! (Next step: embed promo message)', ephemeral: true });
  }
});

client.login(process.env.DISCORD_TOKEN);
