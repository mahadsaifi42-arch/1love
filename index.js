require('dotenv').config();
const { 
    Client, GatewayIntentBits, EmbedBuilder, PermissionsBitField, 
    ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, 
    ButtonStyle, ComponentType, Partials 
} = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, getVoiceConnection, AudioPlayerStatus } = require('@discordjs/voice');
const play = require('play-dl');
const express = require('express');
const fs = require('fs');

// --- RENDER SERVER ---
const app = express();
app.get('/', (req, res) => res.send('Bot is running ✅'));
app.listen(process.env.PORT || 10000);

// --- BOT CONFIG ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildVoiceStates
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

// --- CUSTOM EMOJIS & FALLBACKS ---
const EMOJIS = {
    success: '<a:TICK_TICK:1214893859151286272>',
    error: '<a:4NDS_wrong:1458407390419615756>',
    lock: '<a:lock_keyggchillhaven:1307838252568412202>',
    music: '<a:Music:1438190819512422447>',
    headphones: '<:0041_headphones:1443333046823813151>',
    question: '<a:question:1264568031019925545>'
};

const FALLBACKS = {
    success: '✅', error: '❌', lock: '🔒', music: '🎵', headphones: '🎧', question: '❓'
};

// Emoji helper function
const getEmoji = (name) => EMOJIS[name] || FALLBACKS[name];

// --- DATABASE ---
const DB_PATH = './database.json';
let db = {
    whitelist: {}, afk: {}, warns: {}, config: { logs: null, welcome: null, autorole: null },
    autoreply: {}, autoreact: {}
};
if (fs.existsSync(DB_PATH)) db = JSON.parse(fs.readFileSync(DB_PATH));
const saveDB = () => fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));

// --- STYLE HELPER (XLare Style) ---
const createEmbed = (text, type = 'success') => {
    return new EmbedBuilder()
        .setColor('#000000')
        .setDescription(`${getEmoji(type)} ${text}`);
};

// --- AUTH HELPER ---
const hasAccess = (userId, category) => {
    if (userId === process.env.OWNER_ID) return true;
    const userWl = db.whitelist[userId] || [];
    return userWl.includes(category) || userWl.includes('prefixless');
};

// --- EVENTS ---
client.on('ready', () => console.log(`Logged in as ${client.user.tag}`));

client.on('guildMemberAdd', async (member) => {
    if (db.config.autorole) member.roles.add(db.config.autorole).catch(() => {});
    if (db.config.welcome) {
        const chan = member.guild.channels.cache.get(db.config.welcome);
        if (chan) chan.send({ embeds: [createEmbed(`Welcome ${member}! Enjoy your stay.`, 'success')] });
    }
});

client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;

    // 1. AFK Logic
    if (db.afk[message.author.id]) {
        delete db.afk[message.author.id];
        saveDB();
        message.reply({ embeds: [createEmbed(`Welcome back! Your AFK has been removed.`, 'success')] }).then(m => setTimeout(() => m.delete(), 5000));
    }

    if (message.mentions.users.size > 0) {
        message.mentions.users.forEach(u => {
            if (db.afk[u.id]) {
                const timeAgo = Math.floor((Date.now() - db.afk[u.id].time) / 60000);
                message.reply({ embeds: [createEmbed(`${u.tag} is AFK: **${db.afk[u.id].reason}** (${timeAgo}m ago)`, 'headphones')] });
            }
        });
    }

    // 2. Auto Reply/React
    const trigger = message.content.toLowerCase();
    if (db.autoreply[trigger]) message.reply(db.autoreply[trigger]);
    if (db.autoreact[trigger]) message.react(db.autoreact[trigger]).catch(() => {});

    // 3. Command Handler (Prefix & Prefixless)
    const prefix = process.env.PREFIX || '$';
    let command, args;

    if (message.content.startsWith(prefix)) {
        args = message.content.slice(prefix.length).trim().split(/ +/);
        command = args.shift().toLowerCase();
    } else if (hasAccess(message.author.id, 'prefixless')) {
        args = message.content.trim().split(/ +/);
        command = args.shift().toLowerCase();
    } else return;

    executeCommand(message, command, args);
});

async function executeCommand(message, cmd, args) {
    const { member, channel, guild, author } = message;

    try {
        switch (cmd) {
            case 'ping':
                message.reply({ embeds: [createEmbed(`Latency: \`${client.ws.ping}ms\``)] });
                break;

            case 'wl':
                if (author.id !== process.env.OWNER_ID) return;
                const sub = args[0];
                if (sub === 'add') {
                    const target = message.mentions.users.first();
                    const category = args[2];
                    if (!target || !category) return message.reply({ embeds: [createEmbed('Usage: $wl add @user <category>', 'question')] });
                    if (!db.whitelist[target.id]) db.whitelist[target.id] = [];
                    db.whitelist[target.id].push(category);
                    saveDB();
                    message.reply({ embeds: [createEmbed(`Added **${target.tag}** to \`${category}\``)] });
                } else if (sub === 'list') {
                    const list = Object.entries(db.whitelist).map(([id, cats]) => `<@${id}>: \`${cats.join(', ')}\``).join('\n') || 'None';
                    message.reply({ embeds: [createEmbed(`**Whitelisted Users:**\n${list}`, 'question')] });
                } else {
                    const row = new ActionRowBuilder().addComponents(
                        new StringSelectMenuBuilder().setCustomId('wl_menu').setPlaceholder('Select Whitelist Category').addOptions([
                            { label: 'Ban', value: 'ban' }, { label: 'Mute', value: 'mute' }, { label: 'Prefixless', value: 'prefixless' },
                            { label: 'Lock', value: 'lock' }, { label: 'Purge', value: 'purge' }, { label: 'Hide', value: 'hide' }
                        ])
                    );
                    message.reply({ embeds: [createEmbed('Select a category to manage:', 'question')], components: [row] });
                }
                break;

            case 'ban':
                if (!hasAccess(author.id, 'ban') && !member.permissions.has(PermissionsBitField.Flags.BanMembers)) return;
                const bUser = message.mentions.members.first();
                if (!bUser) return message.reply({ embeds: [createEmbed('Mention a user to ban.', 'error')] });
                await bUser.ban({ reason: args.slice(1).join(' ') || 'No reason' });
                message.reply({ embeds: [createEmbed(`Banned **${bUser.user.tag}**`, 'success')] });
                break;

            case 'lock':
                if (!hasAccess(author.id, 'lock') && !member.permissions.has(PermissionsBitField.Flags.ManageChannels)) return;
                await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false });
                message.reply({ embeds: [createEmbed('Channel Locked.', 'lock')] });
                break;

            case 'unlock':
                if (!hasAccess(author.id, 'lock') && !member.permissions.has(PermissionsBitField.Flags.ManageChannels)) return;
                await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: true });
                message.reply({ embeds: [createEmbed('Channel Unlocked.', 'success')] });
                break;

            case 'play':
                if (!member.voice.channel) return message.reply({ embeds: [createEmbed('Join a voice channel first!', 'error')] });
                const query = args.join(' ');
                if (!query) return message.reply({ embeds: [createEmbed('Provide a song name or link.', 'question')] });
                
                const connection = joinVoiceChannel({ channelId: member.voice.channel.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator });
                const stream = await play.stream(query);
                const resource = createAudioResource(stream.stream, { inputType: stream.type });
                const player = createAudioPlayer();
                player.play(resource);
                connection.subscribe(player);
                message.reply({ embeds: [createEmbed(`Playing: **${query}**`, 'music')] });
                break;

            case 'afk':
                db.afk[author.id] = { reason: args.join(' ') || 'AFK', time: Date.now() };
                saveDB();
                message.reply({ embeds: [createEmbed(`You are now AFK: ${db.afk[author.id].reason}`, 'headphones')] });
                break;

            case 'purge':
                if (!hasAccess(author.id, 'purge') && !member.permissions.has(PermissionsBitField.Flags.ManageMessages)) return;
                const amount = parseInt(args[0]);
                if (isNaN(amount) || amount < 1 || amount > 100) return message.reply({ embeds: [createEmbed('Enter amount between 1-100.', 'error')] });
                await channel.bulkDelete(amount, true);
                channel.send({ embeds: [createEmbed(`Purged ${amount} messages.`, 'success')] }).then(m => setTimeout(() => m.delete(), 3000));
                break;

            case 'rr': // Reaction Role (Buttons)
                if (!member.permissions.has(PermissionsBitField.Flags.Administrator)) return;
                const roles = message.mentions.roles;
                if (roles.size === 0) return message.reply("Mention roles: $rr create @Role1 @Role2");
                const buttons = new ActionRowBuilder();
                roles.forEach(role => {
                    buttons.addComponents(new ButtonBuilder().setCustomId(`rr_${role.id}`).setLabel(role.name).setStyle(ButtonStyle.Secondary));
                });
                message.channel.send({ embeds: [createEmbed('Click buttons to get roles:', 'question')], components: [buttons] });
                break;
        }
    } catch (e) {
        console.error(e);
        message.reply({ embeds: [createEmbed('An error occurred. Check my permissions.', 'error')] });
    }
}

// --- INTERACTIONS ---
client.on('interactionCreate', async (int) => {
    if (int.isStringSelectMenu() && int.customId === 'wl_menu') {
        if (int.user.id !== process.env.OWNER_ID) return int.reply({ content: "Only owner!", ephemeral: true });
        int.reply({ content: `Selected: ${int.values[0]}. Now use \`$wl add @user ${int.values[0]}\``, ephemeral: true });
    }

    if (int.isButton() && int.customId.startsWith('rr_')) {
        const roleId = int.customId.split('_')[1];
        const role = int.guild.roles.cache.get(roleId);
        if (!role) return int.reply({ content: "Role not found.", ephemeral: true });
        if (int.member.roles.cache.has(roleId)) {
            await int.member.roles.remove(role);
            int.reply({ content: `Removed role: ${role.name}`, ephemeral: true });
        } else {
            await int.member.roles.add(role);
            int.reply({ content: `Added role: ${role.name}`, ephemeral: true });
        }
    }
});

client.login(process.env.DISCORD_TOKEN);