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
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  StringSelectMenuInteraction,
  StringSelectMenuComponent,
  StringSelectMenuOptionComponent,
  StringSelectMenuBuilder as SelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle
} from 'discord.js';

const {
  DISCORD_TOKEN,
  FORUM_CHANNEL_ID,
  ADMIN_USER_ID
} = process.env;

if (!DISCORD_TOKEN || !FORUM_CHANNEL_ID || !ADMIN_USER_ID) {
  console.error('Missing env vars: DISCORD_TOKEN / FORUM_CHANNEL_ID / ADMIN_USER_ID');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel] // required for DMs
});

// Utility: safe fetch of forum channel
async function getForumChannel(guild) {
  const ch = await guild.channels.fetch(FORUM_CHANNEL_ID).catch(() => null);
  if (!ch || ch.type !== ChannelType.GuildForum) {
    throw new Error('FORUM_CHANNEL_ID is not a Forum Channel or not found.');
  }
  return ch;
}

// Build the ticket panel components
function buildPanelComponents() {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('btn_report_problem')
      .setLabel('Report Server Problem')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('btn_talk_staff')
      .setLabel('Talk to Staff/Admin')
      .setStyle(ButtonStyle.Primary)
  );
  return [row];
}

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // Handle /ticket-panel
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'ticket-panel') {
        const embed = new EmbedBuilder()
          .setTitle('🎫 Support & Reports')
          .setDescription([
            'Use the buttons below:',
            '• **Report Server Problem** → create a post in our **Forum** for tracking.',
            '• **Talk to Staff/Admin** → send a private message to an Admin.'
          ].join('\n'))
          .setColor(0x2b2d31);

        await interaction.reply({
          embeds: [embed],
          components: buildPanelComponents()
        });
      }
      return;
    }

    // Handle buttons
    if (interaction.isButton()) {
      if (interaction.customId === 'btn_report_problem') {
        const modal = new ModalBuilder()
          .setCustomId('modal_report_problem')
          .setTitle('Report Server Problem');

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

        const row1 = new ActionRowBuilder().addComponents(titleInput);
        const row2 = new ActionRowBuilder().addComponents(detailInput);
        modal.addComponents(row1, row2);

        await interaction.showModal(modal);
        return;
      }

      if (interaction.customId === 'btn_talk_staff') {
        const modal = new ModalBuilder()
          .setCustomId('modal_talk_staff')
          .setTitle('Message Admin / Staff');

        const msgInput = new TextInputBuilder()
          .setCustomId('ts_message')
          .setLabel('Your message')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(1500)
          .setPlaceholder('How can we help?');

        const row = new ActionRowBuilder().addComponents(msgInput);
        modal.addComponents(row);

        await interaction.showModal(modal);
        return;
      }
    }

    // Handle modals
    if (interaction.isModalSubmit()) {
      // 1) Report → create forum thread + starter message
      if (interaction.customId === 'modal_report_problem') {
        await interaction.deferReply({ ephemeral: true });

        const title = interaction.fields.getTextInputValue('rp_title').trim();
        const details = interaction.fields.getTextInputValue('rp_details').trim();

        const forum = await getForumChannel(interaction.guild);

        // Create a new forum post with starter message
        const thread = await forum.threads.create({
          name: `${title} — by ${interaction.user.tag}`,
          message: {
            content:
              [
                `**Reporter:** ${interaction.user} (${interaction.user.tag})`,
                `**Title:** ${title}`,
                `**Details:**\n${details}`
              ].join('\n')
          },
          appliedTags: [] // add Tag IDs here if you use forum tags
        });

        await interaction.editReply({
          content: `✅ Your report has been posted: ${thread?.toString() || thread?.url || 'created thread'}. Our team will follow up there.`
        });
        return;
      }

      // 2) Talk to Staff → DM Admin with user message
      if (interaction.customId === 'modal_talk_staff') {
        await interaction.deferReply({ ephemeral: true });

        const message = interaction.fields.getTextInputValue('ts_message').trim();

        // Fetch admin user & DM them
        const adminUser = await client.users.fetch(ADMIN_USER_ID);
        const dmEmbed = new EmbedBuilder()
          .setTitle('👤 New DM to Admin from a user')
          .addFields(
            { name: 'From', value: `${interaction.user} (${interaction.user.tag})`, inline: false },
            { name: 'Message', value: message || '(no content)', inline: false }
          )
          .setTimestamp();

        await adminUser.send({ embeds: [dmEmbed] }).catch(async () => {
          // If admin DMs are closed, fall back to telling the user
          await interaction.editReply({
            content: '⚠️ I could not DM the admin (their DMs might be closed). Please ping an online staff member.'
          });
          return;
        });

        // Confirm to the user (and open bot→user DM thread so they can reply)
        try {
          await interaction.user.send(
            [
              '📨 Your message has been forwarded to the Admin.',
              'They’ll reach out soon. You can reply here to add more info.'
            ].join('\n')
          );
        } catch {
          // user’s DMs are closed; just keep the ephemeral reply
        }

        await interaction.editReply({ content: '✅ Sent your message to the Admin.' });
        return;
      }
    }
  } catch (err) {
    console.error(err);
    if (interaction.isRepliable()) {
      const msg = (err && err.message) ? err.message : 'Unexpected error.';
      try {
        await interaction.reply({ content: `❌ Error: ${msg}`, ephemeral: true });
      } catch {
        try {
          await interaction.editReply({ content: `❌ Error: ${msg}` });
        } catch {}
      }
    }
  }
});

client.login(DISCORD_TOKEN);
