const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  REST,
  Routes
} = require('discord.js');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ============ CONFIG (dari environment variables di Railway) ============
const config = {
  token: process.env.DISCORD_TOKEN,
  clientId: process.env.CLIENT_ID,
  guildId: process.env.GUILD_ID,
  embedColor: '#4b362a',
  winColor: '#4b362a',
  loseColor: '#4b362a',
  defaultWinnerCount: 1,
  defaultRequirement: 'None'
};

// ============ CLIENT ============
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMembers
  ]
});

// ============ IN-MEMORY STORE ============
const giveaways = new Map();
const DATA_FILE = path.join(__dirname, 'giveaways.json');

function loadGiveaways() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      for (const [id, g] of Object.entries(raw)) {
        g.entries = new Set(g.entries);
        giveaways.set(id, g);
      }
      console.log(`📂 Loaded ${giveaways.size} giveaway(s) from disk`);
    }
  } catch (e) { console.error('Failed to load giveaways:', e); }
}

function saveGiveaways() {
  try {
    const out = {};
    for (const [id, g] of giveaways.entries()) {
      out[id] = { ...g, entries: Array.from(g.entries) };
    }
    fs.writeFileSync(DATA_FILE, JSON.stringify(out, null, 2));
  } catch (e) { console.error('Failed to save giveaways:', e); }
}

// ============ SLASH COMMANDS DEFINITION ============
const commands = [
  new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription('Manage giveaways')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(sub =>
      sub.setName('start')
        .setDescription('Start a new giveaway')
        .addStringOption(o =>
          o.setName('prize').setDescription('What are you giving away?').setRequired(true))
        .addIntegerOption(o =>
          o.setName('minutes').setDescription('Duration in minutes').setRequired(true).setMinValue(1))
        .addIntegerOption(o =>
          o.setName('winners').setDescription('Number of winners (default: 1)').setMinValue(1).setMaxValue(20))
        .addStringOption(o =>
          o.setName('requirement').setDescription('Requirement to join (default: None)').setRequired(false))
    )
    .addSubcommand(sub =>
      sub.setName('end')
        .setDescription('End a giveaway immediately')
        .addStringOption(o =>
          o.setName('id').setDescription('Giveaway ID').setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('reroll')
        .setDescription('Reroll a finished giveaway')
        .addStringOption(o =>
          o.setName('id').setDescription('Giveaway ID').setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('list')
        .setDescription('List all active giveaways')
    )
].map(c => c.toJSON());

// ============ READY ============
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  const rest = new REST({ version: '10' }).setToken(config.token);
  try {
    await rest.put(
      Routes.applicationGuildCommands(config.clientId, config.guildId),
      { body: commands }
    );
    console.log('✅ Slash commands registered');
  } catch (e) { console.error('Failed to register commands:', e); }

  loadGiveaways();
  for (const [id, g] of giveaways.entries()) {
    if (g.ended) continue;
    const remaining = g.endsAt - Date.now();
    if (remaining <= 0) {
      endGiveaway(id);
    } else {
      setTimeout(() => endGiveaway(id), remaining);
    }
  }
});

// ============ INTERACTION HANDLER ============
client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === 'giveaway') {
      const sub = interaction.options.getSubcommand();
      if (sub === 'start') return handleStart(interaction);
      if (sub === 'end') return handleEnd(interaction);
      if (sub === 'reroll') return handleReroll(interaction);
      if (sub === 'list') return handleList(interaction);
    }

    if (interaction.isButton() && interaction.customId.startsWith('giveaway_join_')) {
      return handleJoin(interaction);
    }
  } catch (e) {
    console.error(e);
    if (!interaction.replied && !interaction.deferred) {
      interaction.reply({ content: '❌ Something went wrong.', ephemeral: true }).catch(() => {});
    }
  }
});

// ============ HANDLERS ============
async function handleStart(interaction) {
  const prize = interaction.options.getString('prize');
  const minutes = interaction.options.getInteger('minutes');
  const winnerCount = interaction.options.getInteger('winners') || config.defaultWinnerCount;
  const requirement = interaction.options.getString('requirement') || config.defaultRequirement;
  const endsAt = Date.now() + minutes * 60_000;
  const id = crypto.randomBytes(4).toString('hex');

  const embed = new EmbedBuilder()
    .setTitle('🎉 GIVEAWAY 🎉')
    .setDescription(
      `**Prize:** ${prize}\n` +
      `**Winners:** ${winnerCount}\n` +
      `**Requirement:** ${requirement}\n` +
      `**Ends:** <t:${Math.floor(endsAt / 1000)}:R> (<t:${Math.floor(endsAt / 1000)}:f>)\n\n` +
      `Click the button below to join.`
    )
    .setColor(config.embedColor)
    .setFooter({ text: `ID: ${id} • Hosted by ${interaction.user.username}` })
    .setTimestamp(endsAt);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`giveaway_join_${id}`)
      .setLabel('Join Giveaway')
      .setEmoji('🎉')
      .setStyle(ButtonStyle.Primary)
  );

  await interaction.reply({ content: '✅ Giveaway created!', ephemeral: true });
  const msg = await interaction.channel.send({ embeds: [embed], components: [row] });

  const entry = {
    id,
    prize,
    requirement,
    winnerCount,
    endsAt,
    hostId: interaction.user.id,
    hostTag: interaction.user.username,
    messageId: msg.id,
    channelId: msg.channelId,
    entries: [],
    winners: [],
    ended: false
  };
  giveaways.set(id, entry);
  saveGiveaways();

  setTimeout(() => endGiveaway(id), minutes * 60_000);
}

async function handleJoin(interaction) {
  const id = interaction.customId.replace('giveaway_join_', '');
  const g = giveaways.get(id);
  if (!g) return interaction.reply({ content: '❌ Giveaway not found.', ephemeral: true });
  if (g.ended) return interaction.reply({ content: '❌ This giveaway has ended.', ephemeral: true });

  const userId = interaction.user.id;
  const idx = g.entries.indexOf(userId);

  if (idx !== -1) {
    g.entries.splice(idx, 1);
    saveGiveaways();
    return interaction.reply({ content: `❌ You left the giveaway. Total entries: **${g.entries.length}**`, ephemeral: true });
  }

  g.entries.push(userId);
  saveGiveaways();
  return interaction.reply({ content: `✅ You joined! Total entries: **${g.entries.length}**`, ephemeral: true });
}

async function handleEnd(interaction) {
  const id = interaction.options.getString('id');
  const g = giveaways.get(id);
  if (!g) return interaction.reply({ content: '❌ Giveaway not found.', ephemeral: true });
  if (g.ended) return interaction.reply({ content: '❌ Already ended.', ephemeral: true });

  await interaction.reply({ content: '⏹️ Ending giveaway...', ephemeral: true });
  await endGiveaway(id);
}

async function handleReroll(interaction) {
  const id = interaction.options.getString('id');
  const g = giveaways.get(id);
  if (!g) return interaction.reply({ content: '❌ Giveaway not found.', ephemeral: true });
  if (!g.ended) return interaction.reply({ content: '❌ Giveaway still active.', ephemeral: true });
  if (!g.entries.length) return interaction.reply({ content: '❌ No entries to pick from.', ephemeral: true });

  const winner = pickWinners(g.entries, 1)[0];
  g.winners.push(winner);
  saveGiveaways();

  await interaction.reply({ content: `🎲 Reroll winner: <@${winner}>` });
}

async function handleList(interaction) {
  const active = Array.from(giveaways.values()).filter(g => !g.ended);
  if (!active.length) {
    return interaction.reply({ content: 'No active giveaways.', ephemeral: true });
  }
  const desc = active.map(g =>
    `**${g.prize}** — ID: \`${g.id}\` — Ends <t:${Math.floor(g.endsAt / 1000)}:R> — ${g.entries.length} entries`
  ).join('\n');
  const embed = new EmbedBuilder()
    .setTitle('Active Giveaways')
    .setDescription(desc)
    .setColor(config.embedColor);
  return interaction.reply({ embeds: [embed], ephemeral: true });
}

// ============ PICK WINNERS (CRYPTO RANDOM) ============
function pickWinners(pool, count) {
  const arr = [...pool];
  const winners = [];
  while (winners.length < count && arr.length > 0) {
    const idx = crypto.randomInt(0, arr.length);
    winners.push(arr.splice(idx, 1)[0]);
  }
  return winners;
}

// ============ END GIVEAWAY ============
async function endGiveaway(id) {
  const g = giveaways.get(id);
  if (!g || g.ended) return;
  g.ended = true;

  try {
    const channel = await client.channels.fetch(g.channelId);
    const msg = await channel.messages.fetch(g.messageId);

    if (!g.entries.length) {
      const embed = new EmbedBuilder()
        .setTitle('🎉 Giveaway Ended')
        .setDescription(`**Prize:** ${g.prize}\n\n😢 No one entered the giveaway.`)
        .setColor(config.loseColor)
        .setFooter({ text: `ID: ${id}` });
      await msg.edit({ embeds: [embed], components: [] });
      saveGiveaways();
      return;
    }

    const winners = pickWinners(g.entries, g.winnerCount);
    g.winners = winners;
    saveGiveaways();

    const mentions = winners.map(w => `<@${w}>`).join(', ');

    const embed = new EmbedBuilder()
      .setTitle('🎉 Giveaway Ended')
      .setDescription(
        `**Prize:** ${g.prize}\n` +
        `**Winner${winners.length > 1 ? 's' : ''}:** ${mentions}\n` +
        `**Total entries:** ${g.entries.length}`
      )
      .setColor(config.winColor)
      .setFooter({ text: `ID: ${id}` })
      .setTimestamp();

    await msg.edit({ embeds: [embed], components: [] });
    await channel.send(`🎉 Congratulations ${mentions}! You won **${g.prize}**!`);
  } catch (e) {
    console.error('Error ending giveaway:', e);
  }
}

// ============ LOGIN ============
if (!config.token) {
  console.error('❌ DISCORD_TOKEN is missing. Set it in Railway Variables.');
  process.exit(1);
}
if (!config.clientId) {
  console.error('❌ CLIENT_ID is missing. Set it in Railway Variables.');
  process.exit(1);
}
if (!config.guildId) {
  console.error('❌ GUILD_ID is missing. Set it in Railway Variables.');
  process.exit(1);
}

client.login(config.token);
