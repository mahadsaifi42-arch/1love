require('dotenv').config();
const { 
    Client, GatewayIntentBits, EmbedBuilder, PermissionsBitField, 
    ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, 
    ButtonStyle, ComponentType, Partials, ChannelType 
} = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, getVoiceConnection } = require('@discordjs/voice');
const play = require('play-dl');
const express = require('express');
const fs = require('fs');

// --- RENDER WEB SERVER ---
const app = express();
app.get('/', (req, res) => res.send('Bot is running ✅'));
app.listen(process.env.PORT || 10000);

// --- BOT INITIALIZATION ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildVoiceStates
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction],
    allowedMentions: { repliedUser: false } // Mention off on replies
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
const getEmoji = (n) => EMOJIS[n] || '✅';

// --- DATABASE ---
const DB_PATH = './database.json';
let db = {
    whitelist: {}, afk: {}, 
    greet: { welcomeChan: null, welcomeMsg: "Welcome {member}!", leaveChan: null, leaveMsg: "{member} left." },
    tickets: { category: null, count: 0 }
};
if (fs.existsSync(DB_PATH)) db = JSON.parse(fs.readFileSync(DB_PATH));
const saveDB = () => fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));

// --- STYLISH EMBED ---
const xEmbed = (text, type = 'success') => new EmbedBuilder().setColor('#000000').setDescription(`${getEmoji(type)} ${text}`);

// --- HELPERS ---
const isWL = (id, cat) => (id === process.env.OWNER_ID || (db.whitelist[id] && (db.whitelist[id].includes(cat) || db.whitelist[id].includes('prefixless'))));

const parseMsg = (msg, member) => msg.replace(/{member}/g, `${member}`).replace(/{server}/g, `${member.guild.name}`).replace(/{count}/g, `${member.guild.memberCount}`);

// --- GREET EVENTS ---
client.on('guildMemberAdd', m => {
    if (!db.greet.welcomeChan) return;
    const ch = m.guild.channels.cache.get(db.greet.welcomeChan);
    if (ch) ch.send({ embeds: [new EmbedBuilder().setColor('#000000').setDescription(parseMsg(db.greet.welcomeMsg, m)).setThumbnail(m.user.displayAvatarURL())] });
});

// --- COMMAND HANDLER ---
client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;

    // AFK System
    if (db.afk[message.author.id]) {
        delete db.afk[message.author.id]; saveDB();
        message.reply({ embeds: [xEmbed("Welcome back! AFK removed.")] }).then(m => setTimeout(() => m.delete(), 4000));
    }
    message.mentions.users.forEach(u => {
        if (db.afk[u.id]) message.reply({ embeds: [xEmbed(`${u.tag} is AFK: ${db.afk[u.id].reason}`, 'headphones')] });
    });

    const prefix = process.env.PREFIX || '$';
    let cmd, args;
    if (message.content.startsWith(prefix)) {
        args = message.content.slice(prefix.length).trim().split(/ +/);
        cmd = args.shift().toLowerCase();
    } else if (isWL(message.author.id, 'prefixless')) {
        args = message.content.trim().split(/ +/);
        cmd = args.shift().toLowerCase();
    } else return;

    const { member, channel, guild, author } = message;

    try {
        switch (cmd) {
            case 'ping': message.reply({ embeds: [xEmbed(`Latency: \`${client.ws.ping}ms\``)] }); break;

            // --- WHITELIST ---
            case 'wl':
                if (author.id !== process.env.OWNER_ID) return;
                if (args[0] === 'add') {
                    const u = message.mentions.users.first();
                    if (!u || !args[2]) return message.reply("$wl add @user <cat>");
                    if (!db.whitelist[u.id]) db.whitelist[u.id] = [];
                    db.whitelist[u.id].push(args[2]); saveDB();
                    message.reply({ embeds: [xEmbed(`Added **${u.tag}** to \`${args[2]}\``)] });
                } else {
                    const row = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('wl_sel').setPlaceholder('Select Category').addOptions([{ label: 'Ban', value: 'ban' }, { label: 'Prefixless', value: 'prefixless' }, { label: 'Lock', value: 'lock' }]));
                    message.reply({ components: [row] });
                }
                break;

            // --- MODERATION ---
            case 'ban':
                if (!isWL(author.id, 'ban') && !member.permissions.has(PermissionsBitField.Flags.BanMembers)) return;
                const tu = message.mentions.members.first();
                if (tu) await tu.ban();
                message.reply({ embeds: [xEmbed("Banned successfully.")] });
                break;

            case 'lock':
                if (!isWL(author.id, 'lock') && !member.permissions.has(PermissionsBitField.Flags.ManageChannels)) return;
                await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false });
                message.reply({ embeds: [xEmbed("Channel Locked.", 'lock')] });
                break;

            case 'unlock':
                if (!isWL(author.id, 'lock') && !member.permissions.has(PermissionsBitField.Flags.ManageChannels)) return;
                await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: true });
                message.reply({ embeds: [xEmbed("Channel Unlocked.", 'success')] });
                break;

            // --- MUSIC ---
            case 'play':
                if (!member.voice.channel) return message.reply("Join VC!");
                const conn = joinVoiceChannel({ channelId: member.voice.channel.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator });
                const s = await play.stream(args.join(' '));
                const res = createAudioResource(s.stream, { inputType: s.type });
                const p = createAudioPlayer(); p.play(res); conn.subscribe(p);
                message.reply({ embeds: [xEmbed(`Playing: **${args.join(' ')}**`, 'music')] });
                break;

            // --- GREET ---
            case 'greet':
                if (!member.permissions.has(PermissionsBitField.Flags.Administrator)) return;
                if (args[0] === 'channel') {
                    db.greet.welcomeChan = message.mentions.channels.first()?.id; saveDB();
                    message.reply("Welcome channel set!");
                } else if (args[0] === 'msg') {
                    db.greet.welcomeMsg = args.slice(1).join(' '); saveDB();
                    message.reply("Welcome message set!");
                }
                break;

            // --- TICKET SETUP ---
            case 'ticket-setup':
                if (!member.permissions.has(PermissionsBitField.Flags.Administrator)) return;
                const tEmbed = new EmbedBuilder().setColor('#000000').setTitle('Create a Ticket').setDescription('Click the button below to talk to staff.');
                const tBtn = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('t_open').setLabel('Open Ticket').setStyle(ButtonStyle.Secondary).setEmoji('🎫'));
                channel.send({ embeds: [tEmbed], components: [tBtn] });
                break;

            case 'afk':
                db.afk[author.id] = { reason: args.join(' ') || 'AFK', time: Date.now() }; saveDB();
                message.reply({ embeds: [xEmbed("You are AFK now.", 'headphones')] });
                break;
        }
    } catch (e) { console.error(e); }
});

// --- INTERACTIONS ---
client.on('interactionCreate', async (i) => {
    if (i.isButton()) {
        if (i.customId === 't_open') {
            db.tickets.count++; saveDB();
            const ch = await i.guild.channels.create({
                name: `ticket-${db.tickets.count}`,
                type: ChannelType.GuildText,
                permissionOverwrites: [{ id: i.guild.id, deny: [PermissionsBitField.Flags.ViewChannel] }, { id: i.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] }]
            });
            const closeBtn = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('t_close').setLabel('Close Ticket').setStyle(ButtonStyle.Danger));
            ch.send({ content: `${i.user} Welcome to your ticket. Staff will be with you shortly.`, components: [closeBtn] });
            i.reply({ content: `Ticket created: ${ch}`, ephemeral: true });
        }
        if (i.customId === 't_close') {
            await i.reply("Closing ticket in 5 seconds...");
            setTimeout(() => i.channel.delete(), 5000);
        }
    }
    if (i.isStringSelectMenu() && i.customId === 'wl_sel') {
        i.reply({ content: `Selected: ${i.values[0]}. Use \`$wl add @user ${i.values[0]}\``, ephemeral: true });
    }
});

client.login(process.env.DISCORD_TOKEN);
