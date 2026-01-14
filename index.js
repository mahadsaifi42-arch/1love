const { 
    Client, GatewayIntentBits, EmbedBuilder, PermissionsBitField, 
    ActionRowBuilder, StringSelectMenuBuilder, Partials, ChannelType 
} = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, getVoiceConnection, NoSubscriberBehavior } = require('@discordjs/voice');
const play = require('play-dl');
const express = require('express');
const Database = require('better-sqlite3');
require('dotenv').config();

// --- DATABASE ---
const db = new Database('bot.db');
db.prepare('CREATE TABLE IF NOT EXISTS whitelist (guildId TEXT, userId TEXT, category TEXT, PRIMARY KEY(guildId, userId, category))').run();
db.prepare('CREATE TABLE IF NOT EXISTS afk (userId TEXT PRIMARY KEY, reason TEXT, timestamp INTEGER)').run();

// --- RENDER SERVER ---
const app = express();
app.get('/', (req, res) => res.send('Bot is Secure & Online ✅'));
app.listen(process.env.PORT || 10000);

// --- BOT INITIALIZATION ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildVoiceStates
    ],
    partials: [Partials.Message, Partials.Channel],
    allowedMentions: { repliedUser: false } // ⛔ No ping on replies
});

const PREFIX = process.env.PREFIX || '$';
const OWNER_ID = process.env.OWNER_ID; 

// --- CUSTOM EMOJIS ---
const tick = '<a:AG_ur_right:1458407389228175452>';
const cross = '<a:4NDS_wrong:1460976888863391757>';

const xEmbed = (text, ok = true) => new EmbedBuilder().setColor('#000000').setDescription(`${ok ? tick : cross} ${text}`);

// --- PERMISSION CHECKER FUNCTION ---
const hasPerms = (message, category, discordPerm) => {
    const { member, author, guild } = message;
    if (author.id === OWNER_ID) return true; // Owner Bypass
    if (member.permissions.has(PermissionsBitField.Flags.Administrator)) return true; // Admin Bypass
    
    // Check Database Whitelist
    const userWL = db.prepare('SELECT category FROM whitelist WHERE guildId = ? AND userId = ?').all(guild.id, author.id).map(r => r.category);
    if (userWL.includes(category) || userWL.includes('prefixless')) return true;

    // Check Discord Native Permissions
    if (discordPerm && member.permissions.has(discordPerm)) return true;

    return false;
};

client.on('ready', () => console.log(`✅ ${client.user.tag} fully secured!`));

client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;

    // 1. AFK Logic (Hamesha Public rahega)
    const afk = db.prepare('SELECT * FROM afk WHERE userId = ?').get(message.author.id);
    if (afk) {
        db.prepare('DELETE FROM afk WHERE userId = ?').run(message.author.id);
        message.reply({ embeds: [xEmbed("Welcome back! AFK removed.")] });
    }
    if (message.mentions.users.size > 0) {
        message.mentions.users.forEach(u => {
            const d = db.prepare('SELECT * FROM afk WHERE userId = ?').get(u.id);
            if (d) message.reply({ embeds: [xEmbed(`${u.tag} is AFK: ${d.reason}`, false)] });
        });
    }

    const { content, channel, guild, member, author } = message;
    let cmd, args;

    // --- SECURE COMMAND PARSER ---
    const protectedCmds = ['ban', 'unban', 'mute', 'unmute', 'kick', 'lock', 'unlock', 'hide', 'unhide', 'purge'];

    if (content.startsWith(PREFIX)) {
        args = content.slice(PREFIX.length).trim().split(/ +/);
        cmd = args.shift().toLowerCase();
    } else {
        const first = content.trim().split(/ +/)[0].toLowerCase();
        if (first === 'afk') { cmd = 'afk'; args = content.trim().split(/ +/).slice(1); }
        else if (protectedCmds.includes(first)) {
            cmd = first; args = content.trim().split(/ +/).slice(1);
        } else return;
    }

    // --- COMMAND EXECUTION WITH STRICT LOCKS ---
    try {
        switch (cmd) {
            case 'ping':
                message.reply({ embeds: [xEmbed(`Latency: \`${client.ws.ping}ms\``)] });
                break;

            case 'afk':
                db.prepare('INSERT OR REPLACE INTO afk VALUES (?, ?, ?)').run(author.id, args.join(' ') || 'AFK', Date.now());
                message.reply({ embeds: [xEmbed("AFK Status Enabled.")] });
                break;

            case 'ban':
                if (!hasPerms(message, 'ban', PermissionsBitField.Flags.BanMembers)) return;
                const bUser = message.mentions.members.first() || guild.members.cache.get(args[0]);
                if (!bUser) return message.reply({ embeds: [xEmbed("Mention or ID to ban.", false)] });
                await bUser.ban();
                message.reply({ embeds: [xEmbed(`Banned **${bUser.user.tag}**`)] });
                break;

            case 'mute':
                if (!hasPerms(message, 'mute', PermissionsBitField.Flags.ModerateMembers)) return;
                const mUser = message.mentions.members.first();
                if (!mUser) return message.reply({ embeds: [xEmbed("Mention user to mute.", false)] });
                const time = parseInt(args[1]) || 10;
                await mUser.timeout(time * 60 * 1000);
                message.reply({ embeds: [xEmbed(`Muted **${mUser.user.tag}** for ${time}m`)] });
                break;

            case 'purge':
                if (!hasPerms(message, 'prefixless', PermissionsBitField.Flags.ManageMessages)) return;
                const amt = parseInt(args[0]);
                if (isNaN(amt) || amt < 1 || amt > 100) return message.reply("Provide 1-100.");
                await channel.bulkDelete(amt, true);
                channel.send({ embeds: [xEmbed(`Purged ${amt} messages.`)] }).then(m => setTimeout(() => m.delete(), 3000));
                break;

            case 'lock':
                if (!hasPerms(message, 'lock', PermissionsBitField.Flags.ManageChannels)) return;
                await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false });
                message.reply({ embeds: [xEmbed("Channel Locked.", 'lock')] });
                break;

            case 'unlock':
                if (!hasPerms(message, 'lock', PermissionsBitField.Flags.ManageChannels)) return;
                await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: true });
                message.reply({ embeds: [xEmbed("Channel Unlocked.")] });
                break;

            case 'hide':
                if (!hasPerms(message, 'hide', PermissionsBitField.Flags.ManageChannels)) return;
                await channel.permissionOverwrites.edit(guild.roles.everyone, { ViewChannel: false });
                message.reply({ embeds: [xEmbed("Channel Hidden.")] });
                break;

            case 'unhide':
                if (!hasPerms(message, 'hide', PermissionsBitField.Flags.ManageChannels)) return;
                await channel.permissionOverwrites.edit(guild.roles.everyone, { ViewChannel: true });
                message.reply({ embeds: [xEmbed("Channel Visible.")] });
                break;

            case 'wl':
                if (author.id !== OWNER_ID && !member.permissions.has(PermissionsBitField.Flags.Administrator)) return;
                if (args[0] === 'add') {
                    const target = message.mentions.users.first();
                    const cat = args[2];
                    if (!target || !cat) return message.reply("$wl add @user <category>");
                    db.prepare('INSERT OR REPLACE INTO whitelist VALUES (?, ?, ?)').run(guild.id, target.id, cat);
                    message.reply({ embeds: [xEmbed(`Added **${target.tag}** to \`${cat}\``)] });
                } else {
                    const row = new ActionRowBuilder().addComponents(
                        new StringSelectMenuBuilder().setCustomId('wl_menu').setPlaceholder('Select Category').addOptions([
                            { label: 'Ban', value: 'ban' }, { label: 'Mute', value: 'mute' }, { label: 'Prefixless', value: 'prefixless' }, { label: 'Lock', value: 'lock' }
                        ])
                    );
                    message.reply({ embeds: [xEmbed("Whitelist Panel")], components: [row] });
                }
                break;

            case 'play':
                if (!member.voice.channel) return message.reply("Join a VC!");
                const connection = joinVoiceChannel({ channelId: member.voice.channel.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator });
                const search = await play.search(args.join(' '), { limit: 1 });
                if (!search.length) return message.reply("No results.");
                const stream = await play.stream(search[0].url);
                const player = createAudioPlayer();
                player.play(createAudioResource(stream.stream, { inputType: stream.type }));
                connection.subscribe(player);
                message.reply({ embeds: [xEmbed(`Playing: **${search[0].title}**`)] });
                break;
        }
    } catch (e) {
        console.error(e);
        message.reply({ embeds: [xEmbed("Action Failed: Check my permissions/role position.", false)] });
    }
});

client.on('interactionCreate', async (i) => {
    if (i.isStringSelectMenu() && i.customId === 'wl_menu') {
        if (i.user.id !== OWNER_ID && !i.member.permissions.has(PermissionsBitField.Flags.Administrator)) return i.reply({ content: "No Permission", ephemeral: true });
        await i.reply({ content: `Selected: **${i.values[0]}**. Now use: \`${PREFIX}wl add @user ${i.values[0]}\``, ephemeral: true });
    }
});

client.login(process.env.DISCORD_TOKEN);
