const { 
    Client, GatewayIntentBits, EmbedBuilder, PermissionsBitField, 
    ActionRowBuilder, StringSelectMenuBuilder, Partials 
} = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, getVoiceConnection, NoSubscriberBehavior, AudioPlayerStatus } = require('@discordjs/voice');
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
app.get('/', (req, res) => res.send('Bot Online ✅'));
app.listen(process.env.PORT || 10000);

// --- CLIENT SETUP ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildVoiceStates
    ],
    partials: [Partials.Message, Partials.Channel],
    // PING OFF: Reply pe mention nahi jayega
    allowedMentions: { repliedUser: false }
});

const PREFIX = process.env.PREFIX || '$';
const OWNER_ID = process.env.OWNER_ID; // Make sure this is in your Render Env

// --- EMOJIS ---
const tick = '<a:AG_ur_right:1458407389228175452>';
const cross = '<a:4NDS_wrong:1460976888863391757>';

const xEmbed = (text, ok = true) => new EmbedBuilder().setColor('#000000').setDescription(`${ok ? tick : cross} ${text}`);

// --- HELPERS ---
const getWL = (gId, uId) => db.prepare('SELECT category FROM whitelist WHERE guildId = ? AND userId = ?').all(gId, uId).map(r => r.category);

client.on('ready', () => console.log(`${client.user.tag} Ready!`));

client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;

    // 1. AFK Logic
    const afk = db.prepare('SELECT * FROM afk WHERE userId = ?').get(message.author.id);
    if (afk) {
        db.prepare('DELETE FROM afk WHERE userId = ?').run(message.author.id);
        message.reply({ embeds: [xEmbed("Welcome back! AFK removed.")] });
    }
    message.mentions.users.forEach(u => {
        const d = db.prepare('SELECT * FROM afk WHERE userId = ?').get(u.id);
        if (d) message.reply({ embeds: [xEmbed(`${u.tag} is AFK: ${d.reason}`, false)] });
    });

    // 2. Auth & Command Parse
    const userWL = getWL(message.guild.id, message.author.id);
    const isOwner = message.author.id === OWNER_ID;
    const isAdmin = message.member.permissions.has(PermissionsBitField.Flags.Administrator);
    
    let cmd, args;
    const modCmds = ['ban', 'unban', 'mute', 'unmute', 'kick', 'lock', 'unlock', 'hide', 'unhide', 'purge'];

    if (message.content.startsWith(PREFIX)) {
        args = message.content.slice(PREFIX.length).trim().split(/ +/);
        cmd = args.shift().toLowerCase();
    } else {
        const first = message.content.trim().split(/ +/)[0].toLowerCase();
        if (first === 'afk') { cmd = 'afk'; args = message.content.trim().split(/ +/).slice(1); }
        else if (modCmds.includes(first) && (userWL.includes(first) || userWL.includes('prefixless') || isOwner || isAdmin)) {
            cmd = first; args = message.content.trim().split(/ +/).slice(1);
        } else return;
    }

    // --- COMMANDS ---
    try {
        const { member, channel, guild } = message;

        switch (cmd) {
            case 'ping': message.reply({ embeds: [xEmbed(`Pong! \`${client.ws.ping}ms\``)] }); break;

            case 'wl':
                if (!isOwner && !isAdmin) return; // Only Owner/Admin can manage WL
                if (args[0] === 'add') {
                    const target = message.mentions.users.first();
                    const cat = args[2];
                    if (!target || !cat) return message.reply({ embeds: [xEmbed("Usage: $wl add @user <category>", false)] });
                    db.prepare('INSERT OR REPLACE INTO whitelist VALUES (?, ?, ?)').run(guild.id, target.id, cat);
                    message.reply({ embeds: [xEmbed(`Added **${target.tag}** to \`${cat}\``)] });
                } else if (args[0] === 'panel' || !args[0]) {
                    const row = new ActionRowBuilder().addComponents(
                        new StringSelectMenuBuilder().setCustomId('wl_menu').setPlaceholder('Select Category').addOptions([
                            { label: 'Ban', value: 'ban' }, { label: 'Prefixless', value: 'prefixless' }, { label: 'Lock', value: 'lock' }
                        ])
                    );
                    message.reply({ embeds: [xEmbed("Whitelist Management Panel")], components: [row] });
                }
                break;

            case 'play':
                if (!member.voice.channel) return message.reply({ embeds: [xEmbed("Join a VC first!", false)] });
                const query = args.join(' ');
                if (!query) return message.reply({ embeds: [xEmbed("Provide song name/link", false)] });

                const connection = joinVoiceChannel({
                    channelId: member.voice.channel.id,
                    guildId: guild.id,
                    adapterCreator: guild.voiceAdapterCreator,
                });

                const search = await play.search(query, { limit: 1 });
                if (!search.length) return message.reply({ embeds: [xEmbed("No results found", false)] });

                const stream = await play.stream(search[0].url);
                const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
                const resource = createAudioResource(stream.stream, { inputType: stream.type });

                player.play(resource);
                connection.subscribe(player);
                message.reply({ embeds: [xEmbed(`Started playing: **${search[0].title}**`)] });
                break;

            case 'stop':
                const v = getVoiceConnection(guild.id);
                if (v) { v.destroy(); message.reply({ embeds: [xEmbed("Left Voice Channel")] }); }
                break;

            case 'lock':
                await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false });
                message.reply({ embeds: [xEmbed("Channel Locked.")] });
                break;

            case 'unlock':
                await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: true });
                message.reply({ embeds: [xEmbed("Channel Unlocked.")] });
                break;

            case 'ban':
                const tu = message.mentions.members.first();
                if (!tu) return message.reply("Mention user");
                await tu.ban();
                message.reply({ embeds: [xEmbed(`Banned **${tu.user.tag}**`)] });
                break;

            case 'afk':
                db.prepare('INSERT OR REPLACE INTO afk VALUES (?, ?, ?)').run(message.author.id, args.join(' ') || 'AFK', Date.now());
                message.reply({ embeds: [xEmbed("AFK Status Enabled")] });
                break;

            case 'purge':
                const amount = parseInt(args[0]);
                if (isNaN(amount) || amount < 1 || amount > 100) return message.reply("1-100 only");
                await channel.bulkDelete(amount, true);
                channel.send({ embeds: [xEmbed(`Purged ${amount} messages`)] }).then(m => setTimeout(() => m.delete(), 3000));
                break;
        }
    } catch (e) { console.error(e); message.reply({ embeds: [xEmbed("Error: Check permissions/Role position", false)] }); }
});

client.on('interactionCreate', async (i) => {
    if (i.isStringSelectMenu() && i.customId === 'wl_menu') {
        await i.reply({ content: `Selected: **${i.values[0]}**. Now use: \`${PREFIX}wl add @user ${i.values[0]}\``, ephemeral: true });
    }
});

client.login(process.env.DISCORD_TOKEN);
