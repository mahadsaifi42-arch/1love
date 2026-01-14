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

// --- SERVER (Render Binding) ---
const app = express();
app.get('/', (req, res) => res.send('Bot is Secure ✅'));
app.listen(process.env.PORT || 10000);

// --- CLIENT SETUP ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildVoiceStates
    ],
    partials: [Partials.Message, Partials.Channel],
    allowedMentions: { repliedUser: false } // No ping on replies
});

const PREFIX = process.env.PREFIX || '$';
const OWNER_ID = process.env.OWNER_ID; 

// --- EMOJIS ---
const tick = '<a:AG_ur_right:1458407389228175452>';
const cross = '<a:4NDS_wrong:1460976888863391757>';

const xEmbed = (text, ok = true) => new EmbedBuilder().setColor('#000000').setDescription(`${ok ? tick : cross} ${text}`);

// --- HELPER FUNCTIONS ---
const getWL = (gId, uId) => db.prepare('SELECT category FROM whitelist WHERE guildId = ? AND userId = ?').all(gId, uId).map(r => r.category);

client.on('ready', () => console.log(`${client.user.tag} Secure Version Ready!`));

client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;

    // 1. AFK Logic (Always active)
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

    const { member, author, guild, channel, content } = message;
    const userWL = getWL(guild.id, author.id);
    const isOwner = author.id === OWNER_ID;
    const isAdmin = member.permissions.has(PermissionsBitField.Flags.Administrator);

    // --- COMMAND PARSING & SECURITY CHECK ---
    let cmd, args;
    const modCmds = ['ban', 'unban', 'mute', 'unmute', 'kick', 'lock', 'unlock', 'hide', 'unhide', 'purge'];

    if (content.startsWith(PREFIX)) {
        args = content.slice(PREFIX.length).trim().split(/ +/);
        cmd = args.shift().toLowerCase();
    } else {
        const first = content.trim().split(/ +/)[0].toLowerCase();
        // AFK is allowed for everyone prefixless
        if (first === 'afk') {
            cmd = 'afk';
            args = content.trim().split(/ +/).slice(1);
        } 
        // Mod Commands Prefixless Check: Only if Whitelisted OR Admin OR Owner
        else if (modCmds.includes(first)) {
            const canUsePrefixless = isOwner || isAdmin || userWL.includes('prefixless') || userWL.includes(first);
            if (!canUsePrefixless) return; // SILENT IGNORE FOR NORMAL USERS
            
            cmd = first;
            args = content.trim().split(/ +/).slice(1);
        } else return;
    }

    // --- COMMAND EXECUTION ---
    try {
        switch (cmd) {
            case 'ping':
                message.reply({ embeds: [xEmbed(`Latency: \`${client.ws.ping}ms\``)] });
                break;

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
                            { label: 'Ban', value: 'ban' }, { label: 'Mute', value: 'mute' }, { label: 'Prefixless', value: 'prefixless' }, { label: 'Lock', value: 'lock' }
                        ])
                    );
                    message.reply({ embeds: [xEmbed("Whitelist Panel")], components: [row] });
                }
                break;

            case 'ban':
                if (!isOwner && !isAdmin && !userWL.includes('ban')) return;
                const bUser = message.mentions.members.first();
                if (!bUser) return message.reply("Mention user.");
                if (bUser.roles.highest.position >= member.roles.highest.position && !isOwner) return message.reply("Can't ban higher role!");
                await bUser.ban();
                message.reply({ embeds: [xEmbed(`Banned **${bUser.user.tag}**`)] });
                break;

            case 'kick':
                if (!isOwner && !isAdmin && !userWL.includes('prefixless')) return;
                const kUser = message.mentions.members.first();
                if (!kUser) return message.reply("Mention user.");
                await kUser.kick();
                message.reply({ embeds: [xEmbed(`Kicked **${kUser.user.tag}**`)] });
                break;

            case 'lock':
                if (!isOwner && !isAdmin && !userWL.includes('lock')) return;
                await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false });
                message.reply({ embeds: [xEmbed("Channel Locked.", true)] });
                break;

            case 'unlock':
                if (!isOwner && !isAdmin && !userWL.includes('lock')) return;
                await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: true });
                message.reply({ embeds: [xEmbed("Channel Unlocked.", true)] });
                break;

            case 'play':
                if (!member.voice.channel) return message.reply({ embeds: [xEmbed("Join VC!", false)] });
                const query = args.join(' ');
                if (!query) return message.reply("What to play?");

                const connection = joinVoiceChannel({
                    channelId: member.voice.channel.id,
                    guildId: guild.id,
                    adapterCreator: guild.voiceAdapterCreator,
                });

                const search = await play.search(query, { limit: 1 });
                if (!search.length) return message.reply("No results.");
                const stream = await play.stream(search[0].url);
                const player = createAudioPlayer();
                player.play(createAudioResource(stream.stream, { inputType: stream.type }));
                connection.subscribe(player);
                message.reply({ embeds: [xEmbed(`Playing: **${search[0].title}**`)] });
                break;

            case 'afk':
                db.prepare('INSERT OR REPLACE INTO afk VALUES (?, ?, ?)').run(author.id, args.join(' ') || 'AFK', Date.now());
                message.reply({ embeds: [xEmbed("AFK Enabled")] });
                break;

            case 'purge':
                if (!isAdmin && !userWL.includes('prefixless')) return;
                const amt = parseInt(args[0]);
                if (isNaN(amt) || amt < 1 || amt > 100) return message.reply("1-100 only");
                await channel.bulkDelete(amt, true);
                channel.send({ embeds: [xEmbed(`Purged ${amt} messages`)] }).then(m => setTimeout(() => m.delete(), 3000));
                break;
        }
    } catch (e) {
        console.error(e);
        message.reply({ embeds: [xEmbed("Error: Check permissions/Role hierarchy", false)] });
    }
});

// Select Menu Interaction
client.on('interactionCreate', async (i) => {
    if (i.isStringSelectMenu() && i.customId === 'wl_menu') {
        if (i.user.id !== OWNER_ID && !i.member.permissions.has(PermissionsBitField.Flags.Administrator)) return i.reply({ content: "No permission.", ephemeral: true });
        await i.reply({ content: `Selected: **${i.values[0]}**. Now use: \`${PREFIX}wl add @user ${i.values[0]}\``, ephemeral: true });
    }
});

client.login(process.env.DISCORD_TOKEN);
