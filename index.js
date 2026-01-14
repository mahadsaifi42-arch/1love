const { 
    Client, GatewayIntentBits, EmbedBuilder, PermissionsBitField, 
    ActionRowBuilder, StringSelectMenuBuilder, Partials, ChannelType 
} = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, getVoiceConnection, AudioPlayerStatus } = require('@discordjs/voice');
const play = require('play-dl');
const express = require('express');
const Database = require('better-sqlite3');
const dotenv = require('dotenv');

dotenv.config();

// --- DATABASE SETUP ---
const db = new Database('bot.db');
db.prepare('CREATE TABLE IF NOT EXISTS whitelist (guildId TEXT, userId TEXT, category TEXT, PRIMARY KEY(guildId, userId, category))').run();
db.prepare('CREATE TABLE IF NOT EXISTS afk (userId TEXT PRIMARY KEY, reason TEXT, timestamp INTEGER)').run();

// --- EXPRESS SERVER (Render Port Binding) ---
const app = express();
app.get('/', (req, res) => res.send('Bot is running ✅'));
app.listen(process.env.PORT || 10000);

// --- BOT CLIENT ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildVoiceStates
    ],
    partials: [Partials.Message, Partials.Channel]
});

const PREFIX = process.env.PREFIX || '$';

// --- HELPERS ---
const successEmoji = '☑️';
const errorEmoji = '❎';

const createEmbed = (text, isSuccess = true) => {
    return new EmbedBuilder()
        .setColor('#000000')
        .setDescription(`${isSuccess ? successEmoji : errorEmoji} ${text}`);
};

const getWL = (guildId, userId) => {
    const rows = db.prepare('SELECT category FROM whitelist WHERE guildId = ? AND userId = ?').all(guildId, userId);
    return rows.map(r => r.category);
};

// --- MUSIC HANDLER ---
const players = new Map();

// --- EVENTS ---
client.on('ready', () => console.log(`${client.user.tag} is Online!`));

client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;

    // 1. AFK REMOVAL LOGIC
    const afkData = db.prepare('SELECT * FROM afk WHERE userId = ?').get(message.author.id);
    if (afkData) {
        db.prepare('DELETE FROM afk WHERE userId = ?').run(message.author.id);
        return message.reply({ embeds: [createEmbed(`Welcome back! AFK removed.`)] });
    }

    // 2. AFK MENTION CHECK
    if (message.mentions.users.size > 0) {
        message.mentions.users.forEach(u => {
            const data = db.prepare('SELECT * FROM afk WHERE userId = ?').get(u.id);
            if (data) {
                const timeAgo = Math.floor((Date.now() - data.timestamp) / 60000);
                message.reply({ embeds: [createEmbed(`${u.tag} is AFK: ${data.reason} (${timeAgo}m ago)`, false)] });
            }
        });
    }

    // 3. PARSING LOGIC
    const userWL = getWL(message.guild.id, message.author.id);
    const isAdmin = message.member.permissions.has(PermissionsBitField.Flags.Administrator);
    
    let command, args;
    const prefixlessMods = ['ban', 'unban', 'mute', 'unmute', 'kick', 'lock', 'unlock', 'hide', 'unhide', 'purge'];

    if (message.content.startsWith(PREFIX)) {
        args = message.content.slice(PREFIX.length).trim().split(/ +/);
        command = args.shift().toLowerCase();
    } else {
        const firstWord = message.content.trim().split(/ +/)[0].toLowerCase();
        if (prefixlessMods.includes(firstWord)) {
            // Check if user is whitelisted for this specific command or has 'prefixless' cat
            if (userWL.includes(firstWord) || userWL.includes('prefixless') || isAdmin) {
                args = message.content.trim().split(/ +/);
                command = args.shift().toLowerCase();
            } else return; // Silent ignore
        } else if (firstWord === 'afk') {
            args = message.content.trim().split(/ +/);
            command = args.shift().toLowerCase();
        } else return; // Silent ignore
    }

    // --- COMMANDS ---
    try {
        const { member, channel, guild } = message;

        switch (command) {
            case 'ping':
                message.reply({ embeds: [createEmbed(`Latency: \`${client.ws.ping}ms\``)] });
                break;

            case 'help':
                const help = new EmbedBuilder().setColor('#000000').setTitle('Command List')
                    .addFields(
                        { name: 'Moderation', value: '`ban`, `unban`, `mute`, `unmute`, `kick`, `purge`', inline: true },
                        { name: 'Channel', value: '`lock`, `unlock`, `hide`, `unhide`', inline: true },
                        { name: 'Whitelist', value: '`wl add`, `wl remove`, `wl panel`, `wl list`', inline: true },
                        { name: 'Music', value: '`play`, `stop`, `skip`, `pause`, `resume`', inline: true },
                        { name: 'Utility', value: '`ping`, `afk`', inline: true }
                    );
                message.reply({ embeds: [help] });
                break;

            case 'wl':
                if (!isAdmin) return;
                const sub = args[0];
                if (sub === 'add') {
                    const target = message.mentions.users.first();
                    const cat = args[2];
                    if (!target || !cat) return message.reply({ embeds: [createEmbed('Usage: $wl add @user <category>', false)] });
                    db.prepare('INSERT OR REPLACE INTO whitelist VALUES (?, ?, ?)').run(guild.id, target.id, cat);
                    message.reply({ embeds: [createEmbed(`Added **${target.tag}** to \`${cat}\``)] });
                } else if (sub === 'remove') {
                    const target = message.mentions.users.first();
                    const cat = args[2];
                    db.prepare('DELETE FROM whitelist WHERE guildId = ? AND userId = ? AND category = ?').run(guild.id, target.id, cat);
                    message.reply({ embeds: [createEmbed(`Removed **${target.tag}** from \`${cat}\``)] });
                } else if (sub === 'panel') {
                    const row = new ActionRowBuilder().addComponents(
                        new StringSelectMenuBuilder().setCustomId('wl_panel').setPlaceholder('Select Category').addOptions([
                            { label: 'Ban', value: 'ban' }, { label: 'Mute', value: 'mute' }, 
                            { label: 'Prefixless', value: 'prefixless' }, { label: 'Advertise', value: 'advertise' }, { label: 'Spam', value: 'spam' }
                        ])
                    );
                    message.reply({ embeds: [createEmbed('Select a category to manage whitelist')], components: [row] });
                } else if (sub === 'list') {
                    const list = db.prepare('SELECT userId, category FROM whitelist WHERE guildId = ?').all(guild.id);
                    const listTxt = list.map(l => `<@${l.userId}> - \`${l.category}\``).join('\n') || 'None';
                    message.reply({ embeds: [new EmbedBuilder().setColor('#000000').setTitle('Whitelisted Users').setDescription(listTxt)] });
                }
                break;

            case 'ban':
                const bUser = message.mentions.members.first() || guild.members.cache.get(args[0]);
                if (!bUser) return message.reply({ embeds: [createEmbed('Mention a valid user', false)] });
                await bUser.ban({ reason: args.slice(1).join(' ') || 'No reason' });
                message.reply({ embeds: [createEmbed(`Banned **${bUser.user.tag}** successfully.`)] });
                break;

            case 'unban':
                if (!args[0]) return message.reply({ embeds: [createEmbed('Provide a User ID', false)] });
                await guild.members.unban(args[0]);
                message.reply({ embeds: [createEmbed(`Unbanned \`${args[0]}\` successfully.`)] });
                break;

            case 'mute':
                const mUser = message.mentions.members.first();
                const time = args[1] || '10m';
                const ms = require('util').promisify(setTimeout); // Dummy, use logic below
                let duration = parseInt(time) * 60000;
                if (time.endsWith('h')) duration = parseInt(time) * 3600000;
                if (time.endsWith('d')) duration = parseInt(time) * 86400000;
                await mUser.timeout(duration);
                message.reply({ embeds: [createEmbed(`Muted **${mUser.user.tag}** for ${time}`)] });
                break;

            case 'unmute':
                const umUser = message.mentions.members.first();
                await umUser.timeout(null);
                message.reply({ embeds: [createEmbed(`Unmuted **${umUser.user.tag}**`)] });
                break;

            case 'lock':
                await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false });
                message.reply({ embeds: [createEmbed('Locked channel for @everyone')] });
                break;

            case 'unlock':
                await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: true });
                message.reply({ embeds: [createEmbed('Unlocked channel for @everyone')] });
                break;

            case 'hide':
                await channel.permissionOverwrites.edit(guild.roles.everyone, { ViewChannel: false });
                message.reply({ embeds: [createEmbed('Hidden channel for @everyone')] });
                break;

            case 'unhide':
                await channel.permissionOverwrites.edit(guild.roles.everyone, { ViewChannel: true });
                message.reply({ embeds: [createEmbed('Shown channel for @everyone')] });
                break;

            case 'purge':
                const amount = parseInt(args[0]);
                if (isNaN(amount) || amount < 1 || amount > 100) return message.reply({ embeds: [createEmbed('Provide amount 1-100', false)] });
                await channel.bulkDelete(amount, true);
                channel.send({ embeds: [createEmbed(`Purged ${amount} messages`)] }).then(m => setTimeout(() => m.delete(), 3000));
                break;

            case 'afk':
                const reason = args.join(' ') || 'AFK';
                db.prepare('INSERT OR REPLACE INTO afk VALUES (?, ?, ?)').run(author.id, reason, Date.now());
                message.reply({ embeds: [createEmbed(`AFK Enabled: ${reason}`)] });
                break;

            case 'play':
                if (!member.voice.channel) return message.reply({ embeds: [createEmbed('Join a VC first', false)] });
                const conn = joinVoiceChannel({ channelId: member.voice.channel.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator });
                const stream = await play.stream(args.join(' '));
                const resource = createAudioResource(stream.stream, { inputType: stream.type });
                const player = createAudioPlayer();
                player.play(resource);
                conn.subscribe(player);
                players.set(guild.id, player);
                message.reply({ embeds: [createEmbed(`Playing: **${args.join(' ')}**`)] });
                break;

            case 'stop':
                const vConn = getVoiceConnection(guild.id);
                if (vConn) vConn.destroy();
                message.reply({ embeds: [createEmbed('Stopped and Left VC')] });
                break;
        }
    } catch (err) {
        console.error(err);
        message.reply({ embeds: [createEmbed('Something went wrong. Check permissions.', false)] });
    }
});

client.on('interactionCreate', async (int) => {
    if (int.isStringSelectMenu() && int.customId === 'wl_panel') {
        await int.reply({ content: `Selected: **${int.values[0]}**. Use \`${PREFIX}wl add @user ${int.values[0]}\``, ephemeral: true });
    }
});

client.login(process.env.DISCORD_TOKEN);
