const { 
    Client, GatewayIntentBits, EmbedBuilder, PermissionsBitField, 
    ActionRowBuilder, StringSelectMenuBuilder, Partials, ChannelType 
} = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, getVoiceConnection, AudioPlayerStatus, NoSubscriberBehavior } = require('@discordjs/voice');
const play = require('play-dl');
const express = require('express');
const Database = require('better-sqlite3');
const dotenv = require('dotenv');

dotenv.config();

// --- DATABASE SETUP ---
const db = new Database('bot.db');
db.prepare('CREATE TABLE IF NOT EXISTS whitelist (guildId TEXT, userId TEXT, category TEXT, PRIMARY KEY(guildId, userId, category))').run();
db.prepare('CREATE TABLE IF NOT EXISTS afk (userId TEXT PRIMARY KEY, reason TEXT, timestamp INTEGER)').run();

// --- SERVER FOR RENDER ---
const app = express();
app.get('/', (req, res) => res.send('Bot is running ✅'));
app.listen(process.env.PORT || 10000);

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildVoiceStates
    ],
    partials: [Partials.Message, Partials.Channel]
});

const PREFIX = process.env.PREFIX || '$';

// --- CUSTOM EMOJIS ---
const successEmoji = '<a:AG_ur_right:1458407389228175452>';
const errorEmoji = '<a:4NDS_wrong:1460976888863391757>';

const createEmbed = (text, isSuccess = true) => {
    return new EmbedBuilder()
        .setColor('#000000')
        .setDescription(`${isSuccess ? successEmoji : errorEmoji} ${text}`);
};

const getWL = (guildId, userId) => {
    const rows = db.prepare('SELECT category FROM whitelist WHERE guildId = ? AND userId = ?').all(guildId, userId);
    return rows.map(r => r.category);
};

client.on('ready', () => console.log(`${client.user.tag} is online!`));

client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;

    // 1. AFK REMOVAL (Hamesha active rahega)
    const afkData = db.prepare('SELECT * FROM afk WHERE userId = ?').get(message.author.id);
    if (afkData) {
        db.prepare('DELETE FROM afk WHERE userId = ?').run(message.author.id);
        message.reply({ embeds: [createEmbed(`Welcome back! AFK removed.`)] });
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

    // 3. PARSING
    const userWL = getWL(message.guild.id, message.author.id);
    const isAdmin = message.member.permissions.has(PermissionsBitField.Flags.Administrator);
    const content = message.content.trim();
    
    let command, args;
    const prefixlessAllowed = ['ban', 'unban', 'mute', 'unmute', 'kick', 'lock', 'unlock', 'hide', 'unhide', 'purge', 'afk'];

    if (content.startsWith(PREFIX)) {
        args = content.slice(PREFIX.length).trim().split(/ +/);
        command = args.shift().toLowerCase();
    } else {
        const firstWord = content.split(/ +/)[0].toLowerCase();
        // AFK is prefixless for EVERYONE
        if (firstWord === 'afk') {
            args = content.split(/ +/).slice(1);
            command = 'afk';
        } 
        // Others only for WL/Admins
        else if (prefixlessAllowed.includes(firstWord)) {
            if (userWL.includes(firstWord) || userWL.includes('prefixless') || isAdmin) {
                args = content.split(/ +/).slice(1);
                command = firstWord;
            } else return;
        } else return;
    }

    // --- COMMAND EXECUTION ---
    try {
        const { member, channel, guild, author } = message;

        switch (command) {
            case 'ping':
                message.reply({ embeds: [createEmbed(`Latency: \`${client.ws.ping}ms\``)] });
                break;

            case 'afk':
                const reason = args.join(' ') || 'AFK';
                db.prepare('INSERT OR REPLACE INTO afk VALUES (?, ?, ?)').run(author.id, reason, Date.now());
                message.reply({ embeds: [createEmbed(`AFK Enabled: ${reason}`)] });
                break;

            case 'play':
                if (!member.voice.channel) return message.reply({ embeds: [createEmbed('Join a Voice Channel first!', false)] });
                
                // Connection Fix
                const connection = joinVoiceChannel({
                    channelId: member.voice.channel.id,
                    guildId: guild.id,
                    adapterCreator: guild.voiceAdapterCreator,
                    selfDeaf: true
                });

                const query = args.join(' ');
                if (!query) return message.reply({ embeds: [createEmbed('Provide a song name/link', false)] });

                try {
                    const search = await play.search(query, { limit: 1 });
                    if (search.length === 0) return message.reply({ embeds: [createEmbed('No results found', false)] });

                    const stream = await play.stream(search[0].url);
                    const resource = createAudioResource(stream.stream, { inputType: stream.type });
                    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });

                    player.play(resource);
                    connection.subscribe(player);

                    message.reply({ embeds: [createEmbed(`Started playing: **${search[0].title}**`)] });
                } catch (err) {
                    message.reply({ embeds: [createEmbed('Could not play music. Try a different link.', false)] });
                }
                break;

            case 'stop':
                const vConn = getVoiceConnection(guild.id);
                if (vConn) {
                    vConn.destroy();
                    message.reply({ embeds: [createEmbed('Left the voice channel.')] });
                } else {
                    message.reply({ embeds: [createEmbed('I am not in a voice channel.', false)] });
                }
                break;

            case 'wl':
                if (!isAdmin) return;
                if (args[0] === 'add') {
                    const target = message.mentions.users.first();
                    const cat = args[2];
                    if (!target || !cat) return message.reply({ embeds: [createEmbed('Usage: $wl add @user <category>', false)] });
                    db.prepare('INSERT OR REPLACE INTO whitelist VALUES (?, ?, ?)').run(guild.id, target.id, cat);
                    message.reply({ embeds: [createEmbed(`Added **${target.tag}** to \`${cat}\``)] });
                } else if (args[0] === 'panel') {
                    const row = new ActionRowBuilder().addComponents(
                        new StringSelectMenuBuilder().setCustomId('wl_panel').setPlaceholder('Whitelist Categories').addOptions([
                            { label: 'Ban', value: 'ban' }, { label: 'Prefixless', value: 'prefixless' }, { label: 'Lock', value: 'lock' }
                        ])
                    );
                    message.reply({ embeds: [createEmbed('Choose a category')], components: [row] });
                }
                break;

            case 'ban':
                const bUser = message.mentions.members.first();
                if (!bUser) return message.reply({ embeds: [createEmbed('Mention a valid user', false)] });
                await bUser.ban();
                message.reply({ embeds: [createEmbed(`Banned **${bUser.user.tag}**`)] });
                break;

            case 'lock':
                await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false });
                message.reply({ embeds: [createEmbed('Channel Locked.')] });
                break;

            case 'unlock':
                await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: true });
                message.reply({ embeds: [createEmbed('Channel Unlocked.')] });
                break;

            case 'purge':
                const amount = parseInt(args[0]);
                if (isNaN(amount) || amount < 1 || amount > 100) return message.reply({ embeds: [createEmbed('Provide 1-100', false)] });
                await channel.bulkDelete(amount, true);
                channel.send({ embeds: [createEmbed(`Purged ${amount} messages`)] }).then(m => setTimeout(() => m.delete(), 3000));
                break;
        }
    } catch (err) {
        console.error(err);
        message.reply({ embeds: [createEmbed('Error: Check my permissions/role position.', false)] });
    }
});

client.on('interactionCreate', async (int) => {
    if (int.isStringSelectMenu() && int.customId === 'wl_panel') {
        await int.reply({ content: `Selected: **${int.values[0]}**. Now use: \`${PREFIX}wl add @user ${int.values[0]}\``, ephemeral: true });
    }
});

client.login(process.env.DISCORD_TOKEN);
