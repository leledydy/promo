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
  TextInputBuilder,
  TextInputStyle
} from 'discord.js';

// Optional: simple health server so Railway shows service as “up”
import './server.js';

const { DISCORD_TOKEN, FORUM_CHANNEL_ID, ADMIN_USER_ID } = process.env;

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
  partials: [Partials.Channel]
});

async function getForumChannel(guild) {
  const ch = await guild.channels.fetch(FORUM_CHANNEL_ID).catch(() => null);
  if (!ch || ch.type !== ChannelType.GuildForum) {
    throw new Error('FORUM_CHANNEL_ID is not a Forum Channel or not found.');
  }
  return ch;
}

function panelComponents() {
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

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === 'ticket-panel') {
      const embed = new EmbedBuilder()
        .setTitle('🎫 Support & Reports')
        .setDescription([
          'Use the buttons below:',
          '• **Report Server Problem** → creates a **Forum post** for tracking.',
          '• **Talk to Staff/Admin** → sends a **private message** to an Admin.'
        ].join('\n'))
        .setColor(0x2b2d31);

      await interaction.reply({ embeds: [embed], components: panelComponents() });
      return;
    }

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

        await interaction.showModal(modal.addComponents(
          new ActionRowBuilder().addComponents(titleInput),
          new ActionRowBuilder().addComponents(detailInput)
        ));
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

        await interaction.showModal(modal.addComponents(
          new ActionRowBuilder().addComponents(msgInput)
        ));
        return;
      }
    }

    if (interaction.isModalSubmit()) {
      if (interaction.customId === 'modal_report_problem') {
        await interaction.deferReply({ ephemeral: true });

        const title = interaction.fields.getTextInputValue('rp_title').trim();
        const details = interaction.fields.getTextInputValue('rp_details').trim();
        const forum = await getForumChannel(interaction.guild);

        const thread = await forum.threads.create({
          name: `${title} — by ${interaction.user.tag}`,
          message: {
            content: [
              `**Reporter:** ${interaction.user} (${interaction.user.tag})`,
              `**Title:** ${title}`,
              `**Details:**\n${details}`
            ].join('\n')
          },
          appliedTags: []
        });

        await interaction.editReply({
          content: `✅ Your report has been posted: ${thread?.toString() || thread?.url || 'created thread'}.`
        });
        return;
      }

      if (interaction.customId === 'modal_talk_staff') {
        await interaction.deferReply({ ephemeral: true });

        const message = interaction.fields.getTextInputValue('ts_message').trim();
        const adminUser = await client.users.fetch(ADMIN_USER_ID);

        const dmEmbed = new EmbedBuilder()
          .setTitle('👤 New message to Admin')
          .addFields(
            { name: 'From', value: `${interaction.user} (${interaction.user.tag})` },
            { name: 'Message', value: message || '(no content)' }
          )
          .setTimestamp();

        await adminUser.send({ embeds: [dmEmbed] }).catch(async () => {
          await interaction.editReply({
            content: '⚠️ Could not DM the admin (DMs might be closed). Please ping a staff member.'
          });
          return;
        });

        try {
          await interaction.user.send([
            '📨 Your message has been forwarded to the Admin.',
            'You can reply here to add more info.'
          ].join('\n'));
        } catch { /* user DMs closed – ignore */ }

        await interaction.editReply({ content: '✅ Sent your message to the Admin.' });
        return;
      }
    }
  } catch (err) {
    console.error(err);
    if (interaction.isRepliable()) {
      const msg = (err && err.message) ? err.message : 'Unexpected error.';
      try { await interaction.reply({ content: `❌ Error: ${msg}`, ephemeral: true }); }
      catch { try { await interaction.editReply({ content: `❌ Error: ${msg}` }); } catch {}
      }
    }
  }
});

client.login(DISCORD_TOKEN);
