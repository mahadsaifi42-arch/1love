require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} = require("discord.js");

const express = require("express");
const Database = require("better-sqlite3");

const {
  joinVoiceChannel,
  getVoiceConnection,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
} = require("@discordjs/voice");

const play = require("play-dl");
const sodium = require("libsodium-wrappers");
const ffmpegPath = require("ffmpeg-static");

// =================== CONFIG ===================
const PREFIX = "$";
const OWNER_ID = process.env.OWNER_ID || ""; // put your discord id in .env
const TOKEN = process.env.TOKEN;

const EMBED_COLOR = 0x000000; // black

// Emojis (fix + clean)
const EMOJI = {
  ok: "✅",
  no: "❌",
  lock: "🔒",
  unlock: "🔓",
  hide: "🙈",
  unhide: "👁️",
  add: "➕",
  remove: "➖",
  music: "🎵",
  info: "ℹ️",
  warn: "⚠️",
  ping: "🏓",
  list: "📜",
  user: "👤",
};

// =================== EXPRESS (Render keep alive) ===================
const app = express();
app.get("/", (req, res) => res.send("1Love bot is alive!"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Web server running on ${PORT}`));

// =================== DATABASE ===================
const db = new Database("database.sqlite");

// whitelist table
db.prepare(
  `CREATE TABLE IF NOT EXISTS whitelist (
    guildId TEXT NOT NULL,
    userId TEXT NOT NULL,
    category TEXT NOT NULL,
    PRIMARY KEY (guildId, userId, category)
  )`
).run();

// afk table
db.prepare(
  `CREATE TABLE IF NOT EXISTS afk (
    guildId TEXT NOT NULL,
    userId TEXT NOT NULL,
    reason TEXT,
    time INTEGER,
    PRIMARY KEY (guildId, userId)
  )`
).run();

// autoresponse table
db.prepare(
  `CREATE TABLE IF NOT EXISTS autoreply (
    guildId TEXT NOT NULL,
    trigger TEXT NOT NULL,
    reply TEXT NOT NULL,
    PRIMARY KEY (guildId, trigger)
  )`
).run();

// reaction role table
db.prepare(
  `CREATE TABLE IF NOT EXISTS reaction_roles (
    guildId TEXT NOT NULL,
    channelId TEXT NOT NULL,
    messageId TEXT NOT NULL,
    emoji TEXT NOT NULL,
    roleId TEXT NOT NULL,
    PRIMARY KEY (guildId, messageId, emoji)
  )`
).run();

// greet table
db.prepare(
  `CREATE TABLE IF NOT EXISTS greet (
    guildId TEXT NOT NULL PRIMARY KEY,
    channelId TEXT,
    message TEXT
  )`
).run();

// =================== CLIENT ===================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

// =================== HELPERS ===================
function xEmbed(title, desc, ok = true) {
  return new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(`${ok ? EMOJI.ok : EMOJI.no} ${title}`)
    .setDescription(desc || "‎");
}

async function safeReply(message, payload) {
  // no mention reply
  return message.reply({
    allowedMentions: { repliedUser: false },
    ...payload,
  });
}

function isOwner(authorId) {
  return OWNER_ID && authorId === OWNER_ID;
}

function isAdmin(member) {
  return member.permissions.has(PermissionsBitField.Flags.Administrator);
}

function getUserWhitelist(guildId, userId) {
  return db
    .prepare("SELECT category FROM whitelist WHERE guildId=? AND userId=?")
    .all(guildId, userId)
    .map((r) => r.category);
}

// prefixless moderation allowed only if user is whitelisted in that category
function canUsePrefixlessMod(member, guildId, cmd) {
  if (!member) return false;
  if (isOwner(member.id)) return true;
  if (isAdmin(member)) return true;

  const list = getUserWhitelist(guildId, member.id);

  // categories: ban, mute, lock, hide, prefixless
  if (list.includes("prefixless")) return true;

  if (["ban", "unban", "kick"].includes(cmd)) return list.includes("ban");
  if (["mute", "unmute"].includes(cmd)) return list.includes("mute");
  if (["lock", "unlock"].includes(cmd)) return list.includes("lock");
  if (["hide", "unhide"].includes(cmd)) return list.includes("hide");

  // music prefixless can be allowed by "prefixless" only
  if (["j", "join", "dc", "disconnect", "play", "p", "skip", "stop", "pause", "resume", "loop", "shuffle", "queue", "q", "np"].includes(cmd)) {
    return list.includes("prefixless");
  }

  return false;
}

function hasDiscordPermission(member, cmd) {
  const map = {
    ban: PermissionsBitField.Flags.BanMembers,
    unban: PermissionsBitField.Flags.BanMembers,
    kick: PermissionsBitField.Flags.KickMembers,
    mute: PermissionsBitField.Flags.ModerateMembers,
    unmute: PermissionsBitField.Flags.ModerateMembers,
    purge: PermissionsBitField.Flags.ManageMessages,
    lock: PermissionsBitField.Flags.ManageChannels,
    unlock: PermissionsBitField.Flags.ManageChannels,
    hide: PermissionsBitField.Flags.ManageChannels,
    unhide: PermissionsBitField.Flags.ManageChannels,
  };
  const perm = map[cmd];
  if (!perm) return true;
  return member.permissions.has(perm);
}

function parseUserId(str) {
  if (!str) return null;
  const m = str.match(/^<@!?(\d+)>$/);
  if (m) return m[1];
  if (/^\d{15,25}$/.test(str)) return str;
  return null;
}

async function ensureVoiceConnection(guild, member) {
  if (!member.voice.channel) return null;

  let conn = getVoiceConnection(guild.id);
  if (!conn) {
    conn = joinVoiceChannel({
      channelId: member.voice.channel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
    });
  }
  return conn;
}

// =================== MUSIC STATE ===================
const music = new Map(); // guildId => { queue:[], player, connection, loop, nowPlaying }

function getGuildMusic(guildId) {
  if (!music.has(guildId)) {
    const player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });

    music.set(guildId, {
      queue: [],
      player,
      connection: null,
      loop: false,
      nowPlaying: null,
    });
  }
  return music.get(guildId);
}

async function playNext(guild, message) {
  const gm = getGuildMusic(guild.id);

  if (!gm.queue.length) {
    gm.nowPlaying = null;
    return;
  }

  const track = gm.queue[0];
  gm.nowPlaying = track;

  try {
    // youtube stream
    const ytInfo = await play.video_basic_info(track.url);
    const stream = await play.stream_from_info(ytInfo, { quality: 2 });

    const resource = createAudioResource(stream.stream, {
      inputType: stream.type || StreamType.Arbitrary,
      inlineVolume: true,
    });
    resource.volume.setVolume(1.0);

    gm.player.play(resource);

    await safeReply(message, {
      embeds: [
        xEmbed(
          "Now Playing",
          `${EMOJI.music} **${track.title}**\n🔗 ${track.url}`,
          true
        ),
      ],
    });
  } catch (e) {
    console.log("Music error:", e);
    gm.queue.shift();
    return safeReply(message, {
      embeds: [xEmbed("Error", "Failed to play this track. Skipping...", false)],
    }).then(() => playNext(guild, message));
  }
}

// =================== READY ===================
client.once("ready", async () => {
  await sodium.ready;
  console.log(`${client.user.tag} is online!`);

  // attach idle listener per guild music
  client.guilds.cache.forEach((g) => {
    const gm = getGuildMusic(g.id);

    gm.player.on(AudioPlayerStatus.Idle, async () => {
      if (!gm.queue.length) return;

      // if loop off => remove current
      if (!gm.loop) gm.queue.shift();

      // play next
      const textCh =
        g.systemChannel ||
        g.channels.cache.find((c) => c.isTextBased && c.isTextBased());
      if (!textCh) return;

      const fakeMsg = {
        guild: g,
        channel: textCh,
        reply: (p) => textCh.send({ allowedMentions: { repliedUser: false }, ...p }),
      };

      await playNext(g, fakeMsg);
    });

    gm.player.on("error", (err) => {
      console.log("Player error:", err);
    });
  });
});

// =================== GUILD MEMBER ADD (WELCOME) ===================
client.on("guildMemberAdd", async (member) => {
  const row = db.prepare("SELECT * FROM greet WHERE guildId=?").get(member.guild.id);
  if (!row || !row.channelId) return;

  const ch = member.guild.channels.cache.get(row.channelId);
  if (!ch || !ch.isTextBased()) return;

  const msg = (row.message || "Welcome {user}!")
    .replaceAll("{user}", `<@${member.id}>`)
    .replaceAll("{server}", member.guild.name);

  ch.send({ content: msg, allowedMentions: { users: [] } });
});

// =================== MESSAGE CREATE ===================
client.on("messageCreate", async (message) => {
  try {
    if (!message.guild) return;
    if (message.author.bot) return;

    const guild = message.guild;
    const member = await guild.members.fetch(message.author.id);

    const text = message.content.trim();

    // ---------- AFK REMOVE ON MESSAGE ----------
    const afkRow = db
      .prepare("SELECT * FROM afk WHERE guildId=? AND userId=?")
      .get(guild.id, message.author.id);

    if (afkRow) {
      db.prepare("DELETE FROM afk WHERE guildId=? AND userId=?").run(
        guild.id,
        message.author.id
      );
      safeReply(message, {
        embeds: [xEmbed("AFK Removed", "Welcome back!", true)],
      });
    }

    // ---------- AFK PING CHECK ----------
    if (message.mentions.users.size) {
      for (const [uid] of message.mentions.users) {
        const row = db
          .prepare("SELECT * FROM afk WHERE guildId=? AND userId=?")
          .get(guild.id, uid);
        if (row) {
          const since = `<t:${Math.floor(row.time / 1000)}:R>`;
          safeReply(message, {
            embeds: [
              xEmbed(
                "AFK",
                `${EMOJI.info} <@${uid}> is AFK\n**Reason:** ${row.reason || "No reason"}\n**Since:** ${since}`,
                true
              ),
            ],
          });
        }
      }
    }

    // ---------- AUTO REPLY ----------
    const ar = db
      .prepare("SELECT reply FROM autoreply WHERE guildId=? AND trigger=?")
      .get(guild.id, text.toLowerCase());
    if (ar?.reply) {
      return message.channel.send({
        content: ar.reply,
        allowedMentions: { parse: [] },
      });
    }

    // =================== COMMAND PARSING ===================
    let cmd = null;
    let args = [];
    let isPrefixless = false;

    // aliases
    const alias = {
      j: "join",
      dc: "disconnect",
      d: "disconnect",
      p: "play",
      q: "queue",
      np: "np",
    };

    const modCmds = [
      "ban",
      "unban",
      "kick",
      "mute",
      "unmute",
      "purge",
      "lock",
      "unlock",
      "hide",
      "unhide",
    ];

    const musicCmds = [
      "join",
      "disconnect",
      "play",
      "skip",
      "stop",
      "pause",
      "resume",
      "loop",
      "shuffle",
      "queue",
      "np",
    ];

    // PREFIX commands
    if (text.startsWith(PREFIX)) {
      const sliced = text.slice(PREFIX.length).trim();
      if (!sliced) return;

      args = sliced.split(/\s+/);
      cmd = (args.shift() || "").toLowerCase();
      cmd = alias[cmd] || cmd;
      isPrefixless = false;
    } else {
      // PREFIXLESS: only AFK public OR whitelisted mod/music
      const first = text.split(/\s+/)[0]?.toLowerCase();
      const rest = text.split(/\s+/).slice(1);

      // AFK public prefixless
      if (first === "afk") {
        cmd = "afk";
        args = rest;
        isPrefixless = true;
      } else if ([...modCmds, ...musicCmds].includes(alias[first] || first)) {
        cmd = alias[first] || first;
        args = rest;
        isPrefixless = true;
      } else {
        return; // ignore normal chat
      }
    }

    // =================== SECURITY VALIDATION ===================
    // If command is moderation/music and prefixless => require whitelist/admin/owner
    if (isPrefixless && (modCmds.includes(cmd) || musicCmds.includes(cmd))) {
      const allowed = canUsePrefixlessMod(member, guild.id, cmd);
      if (!allowed) {
        return safeReply(message, {
          embeds: [
            xEmbed(
              "Not Whitelisted",
              `You are not allowed to use prefixless **${cmd}**.`,
              false
            ),
          ],
        });
      }
    }

    // For moderation commands always require Discord permissions unless owner/admin
    if (modCmds.includes(cmd)) {
      if (!isOwner(message.author.id) && !isAdmin(member)) {
        if (!hasDiscordPermission(member, cmd)) {
          return safeReply(message, {
            embeds: [
              xEmbed(
                "No Permission",
                `You need proper Discord permission to use **${cmd}**.`,
                false
              ),
            ],
          });
        }
      }
    }

    // =================== COMMANDS ===================
    // ---- BASIC ----
    if (cmd === "ping") {
      return safeReply(message, {
        embeds: [
          xEmbed(
            "Pong!",
            `${EMOJI.ping} Latency: **${client.ws.ping}ms**`,
            true
          ),
        ],
      });
    }

    if (cmd === "help") {
      return safeReply(message, {
        embeds: [
          xEmbed(
            "Help",
            `**Prefix:** \`${PREFIX}\`

**Moderation**
\`${PREFIX}ban @user [reason]\`
\`${PREFIX}unban <userId>\`
\`${PREFIX}kick @user [reason]\`
\`${PREFIX}mute @user [minutes]\`
\`${PREFIX}unmute @user\`
\`${PREFIX}purge 1-100\`

**Channel**
\`${PREFIX}lock\` / \`${PREFIX}unlock\`
\`${PREFIX}hide\` / \`${PREFIX}unhide\`

**Whitelist**
\`${PREFIX}wl\` (panel)
\`${PREFIX}wl add @user <category>\`
\`${PREFIX}wl remove @user <category>\`
\`${PREFIX}wl list\`

**AFK**
\`${PREFIX}afk [reason]\`
\`afk [reason]\` (prefixless public)

**Music**
\`${PREFIX}j\` / \`${PREFIX}join\`
\`${PREFIX}dc\`
\`${PREFIX}play <name/url>\`
\`${PREFIX}skip\`
\`${PREFIX}stop\`
\`${PREFIX}pause\`
\`${PREFIX}resume\`
\`${PREFIX}loop\`
\`${PREFIX}shuffle\`
\`${PREFIX}q\`
\`${PREFIX}np\`

**Prefixless for whitelisted users**
\`ban/mute/lock/hide/j/dc/play...\``,
            true
          ),
        ],
      });
    }

    // ---- WHITELIST ----
    if (cmd === "wl") {
      const sub = (args[0] || "").toLowerCase();

      // only owner/admin can manage wl
      if (!isOwner(message.author.id) && !isAdmin(member)) {
        return safeReply(message, {
          embeds: [xEmbed("No Permission", "Only Admin/Owner can use whitelist panel.", false)],
        });
      }

      if (!sub || sub === "panel") {
        const menu = new StringSelectMenuBuilder()
          .setCustomId("wl_select")
          .setPlaceholder("Select whitelist category")
          .addOptions([
            { label: "ban", value: "ban", description: "Ban/Kick/Unban prefixless" },
            { label: "mute", value: "mute", description: "Mute/Unmute prefixless" },
            { label: "lock", value: "lock", description: "Lock/Unlock prefixless" },
            { label: "hide", value: "hide", description: "Hide/Unhide prefixless" },
            { label: "prefixless", value: "prefixless", description: "All prefixless commands" },
          ]);

        const row = new ActionRowBuilder().addComponents(menu);

        return safeReply(message, {
          embeds: [
            xEmbed(
              "Whitelist Panel",
              `${EMOJI.list} Choose a category, then use:
\`${PREFIX}wl add @user <category>\`
\`${PREFIX}wl remove @user <category>\``,
              true
            ),
          ],
          components: [row],
        });
      }

      if (sub === "add") {
        const userId = parseUserId(args[1]);
        const category = (args[2] || "").toLowerCase();

        if (!userId || !category) {
          return safeReply(message, {
            embeds: [xEmbed("Usage", `${PREFIX}wl add @user <ban/mute/lock/hide/prefixless>`, false)],
          });
        }

        const allowedCats = ["ban", "mute", "lock", "hide", "prefixless"];
        if (!allowedCats.includes(category)) {
          return safeReply(message, {
            embeds: [xEmbed("Invalid Category", `Allowed: ${allowedCats.join(", ")}`, false)],
          });
        }

        db.prepare("INSERT OR IGNORE INTO whitelist (guildId,userId,category) VALUES (?,?,?)").run(
          guild.id,
          userId,
          category
        );

        return safeReply(message, {
          embeds: [
            xEmbed(
              "Whitelisted",
              `${EMOJI.ok} Added <@${userId}> to **${category}** whitelist.`,
              true
            ),
          ],
        });
      }

      if (sub === "remove") {
        const userId = parseUserId(args[1]);
        const category = (args[2] || "").toLowerCase();

        if (!userId || !category) {
          return safeReply(message, {
            embeds: [xEmbed("Usage", `${PREFIX}wl remove @user <ban/mute/lock/hide/prefixless>`, false)],
          });
        }

        db.prepare("DELETE FROM whitelist WHERE guildId=? AND userId=? AND category=?").run(
          guild.id,
          userId,
          category
        );

        return safeReply(message, {
          embeds: [
            xEmbed(
              "Removed",
              `${EMOJI.remove} Removed <@${userId}> from **${category}** whitelist.`,
              true
            ),
          ],
        });
      }

      if (sub === "list") {
        const rows = db
          .prepare("SELECT userId, category FROM whitelist WHERE guildId=?")
          .all(guild.id);

        if (!rows.length) {
          return safeReply(message, { embeds: [xEmbed("Whitelist", "No users whitelisted.", true)] });
        }

        const grouped = {};
        for (const r of rows) {
          if (!grouped[r.userId]) grouped[r.userId] = [];
          grouped[r.userId].push(r.category);
        }

        let out = "";
        for (const uid of Object.keys(grouped)) {
          out += `${EMOJI.user} <@${uid}> → **${grouped[uid].join(", ")}**\n`;
        }

        return safeReply(message, { embeds: [xEmbed("Whitelist List", out, true)] });
      }
    }

    // ---- AFK ----
    if (cmd === "afk") {
      const reason = args.join(" ").trim() || "AFK";
      db.prepare("INSERT OR REPLACE INTO afk (guildId,userId,reason,time) VALUES (?,?,?,?)").run(
        guild.id,
        message.author.id,
        reason,
        Date.now()
      );

      return safeReply(message, {
        embeds: [xEmbed("AFK Enabled", `Reason: **${reason}**`, true)],
      });
    }

    // ---- MODERATION ----
    if (cmd === "ban") {
      const userId = parseUserId(args[0]);
      const reason = args.slice(1).join(" ") || "No reason";
      if (!userId) return safeReply(message, { embeds: [xEmbed("Usage", `${PREFIX}ban @user [reason]`, false)] });

      const target = await guild.members.fetch(userId).catch(() => null);
      if (!target) return safeReply(message, { embeds: [xEmbed("Error", "Invalid user.", false)] });

      if (!target.bannable) return safeReply(message, { embeds: [xEmbed("Error", "I can't ban this user.", false)] });

      await target.ban({ reason });
      return safeReply(message, { embeds: [xEmbed("Banned", `${EMOJI.ok} Banned <@${userId}>\nReason: **${reason}**`, true)] });
    }

    if (cmd === "unban") {
      const userId = parseUserId(args[0]);
      if (!userId) return safeReply(message, { embeds: [xEmbed("Usage", `${PREFIX}unban <userId>`, false)] });

      await guild.bans.remove(userId).catch(() => null);
      return safeReply(message, { embeds: [xEmbed("Unbanned", `${EMOJI.ok} Unbanned **${userId}**`, true)] });
    }

    if (cmd === "kick") {
      const userId = parseUserId(args[0]);
      const reason = args.slice(1).join(" ") || "No reason";
      if (!userId) return safeReply(message, { embeds: [xEmbed("Usage", `${PREFIX}kick @user [reason]`, false)] });

      const target = await guild.members.fetch(userId).catch(() => null);
      if (!target) return safeReply(message, { embeds: [xEmbed("Error", "Invalid user.", false)] });

      if (!target.kickable) return safeReply(message, { embeds: [xEmbed("Error", "I can't kick this user.", false)] });

      await target.kick(reason);
      return safeReply(message, { embeds: [xEmbed("Kicked", `${EMOJI.ok} Kicked <@${userId}>\nReason: **${reason}**`, true)] });
    }

    if (cmd === "mute") {
      const userId = parseUserId(args[0]);
      const minutes = parseInt(args[1] || "10");
      if (!userId) return safeReply(message, { embeds: [xEmbed("Usage", `${PREFIX}mute @user [minutes]`, false)] });

      const target = await guild.members.fetch(userId).catch(() => null);
      if (!target) return safeReply(message, { embeds: [xEmbed("Error", "Invalid user.", false)] });

      const ms = Math.max(1, minutes) * 60 * 1000;
      await target.timeout(ms, "Muted by bot");
      return safeReply(message, { embeds: [xEmbed("Muted", `${EMOJI.ok} Muted <@${userId}> for **${minutes} min**`, true)] });
    }

    if (cmd === "unmute") {
      const userId = parseUserId(args[0]);
      if (!userId) return safeReply(message, { embeds: [xEmbed("Usage", `${PREFIX}unmute @user`, false)] });

      const target = await guild.members.fetch(userId).catch(() => null);
      if (!target) return safeReply(message, { embeds: [xEmbed("Error", "Invalid user.", false)] });

      await target.timeout(null);
      return safeReply(message, { embeds: [xEmbed("Unmuted", `${EMOJI.ok} Unmuted <@${userId}>`, true)] });
    }

    if (cmd === "purge") {
      const amount = parseInt(args[0] || "0");
      if (!amount || amount < 1 || amount > 100) {
        return safeReply(message, { embeds: [xEmbed("Usage", `${PREFIX}purge 1-100`, false)] });
      }
      await message.channel.bulkDelete(amount, true).catch(() => null);
      return safeReply(message, { embeds: [xEmbed("Purged", `${EMOJI.ok} Deleted **${amount}** messages.`, true)] });
    }

    // ---- CHANNEL LOCK/HIDE @everyone ----
    if (cmd === "lock") {
      await message.channel.permissionOverwrites.edit(guild.roles.everyone, {
        SendMessages: false,
      });

      return safeReply(message, {
        embeds: [xEmbed("Locked", `${EMOJI.lock} Channel locked for **@everyone**.`, true)],
      });
    }

    if (cmd === "unlock") {
      await message.channel.permissionOverwrites.edit(guild.roles.everyone, {
        SendMessages: null,
      });

      return safeReply(message, {
        embeds: [xEmbed("Unlocked", `${EMOJI.unlock} Channel unlocked for **@everyone**.`, true)],
      });
    }

    if (cmd === "hide") {
      await message.channel.permissionOverwrites.edit(guild.roles.everyone, {
        ViewChannel: false,
      });

      return safeReply(message, {
        embeds: [xEmbed("Hidden", `${EMOJI.hide} Channel hidden for **@everyone**.`, true)],
      });
    }

    if (cmd === "unhide") {
      await message.channel.permissionOverwrites.edit(guild.roles.everyone, {
        ViewChannel: null,
      });

      return safeReply(message, {
        embeds: [xEmbed("Unhidden", `${EMOJI.unhide} Channel visible for **@everyone**.`, true)],
      });
    }

    // ---- MUSIC ----
    const gm = getGuildMusic(guild.id);

    if (cmd === "join") {
      if (!member.voice.channel) {
        return safeReply(message, { embeds: [xEmbed("Error", "Join a voice channel first.", false)] });
      }

      const conn = await ensureVoiceConnection(guild, member);
      gm.connection = conn;
      conn.subscribe(gm.player);

      return safeReply(message, {
        embeds: [xEmbed("Connected", `Joined **${member.voice.channel.name}**`, true)],
      });
    }

    if (cmd === "disconnect") {
      const conn = getVoiceConnection(guild.id);
      if (!conn) return safeReply(message, { embeds: [xEmbed("Error", "I'm not connected in any VC.", false)] });

      conn.destroy();
      gm.queue = [];
      gm.nowPlaying = null;

      return safeReply(message, {
        embeds: [xEmbed("Disconnected", "Left the voice channel.", true)],
      });
    }

    if (cmd === "play") {
      const query = args.join(" ");
      if (!query) return safeReply(message, { embeds: [xEmbed("Usage", `${PREFIX}play <song name/url>`, false)] });

      if (!member.voice.channel) {
        return safeReply(message, { embeds: [xEmbed("Error", "Join a voice channel first.", false)] });
      }

      const conn = await ensureVoiceConnection(guild, member);
      gm.connection = conn;
      conn.subscribe(gm.player);

      let video;
      try {
        if (play.yt_validate(query) === "video") {
          const info = await play.video_basic_info(query);
          video = info.video_details;
        } else {
          const results = await play.search(query, { limit: 1 });
          if (!results.length) {
            return safeReply(message, { embeds: [xEmbed("Error", "No results found.", false)] });
          }
          video = results[0];
        }
      } catch (e) {
        console.log("Search error:", e);
        return safeReply(message, { embeds: [xEmbed("Error", "Search failed.", false)] });
      }

      const track = {
        title: video.title || "Unknown",
        url: video.url,
        requestedBy: message.author.id,
      };

      gm.queue.push(track);

      await safeReply(message, {
        embeds: [
          xEmbed(
            "Added to Queue",
            `${EMOJI.music} **${track.title}**\n🔗 ${track.url}`,
            true
          ),
        ],
      });

      // if not playing start
      if (gm.player.state.status !== AudioPlayerStatus.Playing) {
        return playNext(guild, message);
      }
      return;
    }

    if (cmd === "skip") {
      if (!gm.queue.length) return safeReply(message, { embeds: [xEmbed("Error", "Queue is empty.", false)] });

      gm.queue.shift();
      gm.player.stop(true);

      return safeReply(message, { embeds: [xEmbed("Skipped", "Skipped current track.", true)] });
    }

    if (cmd === "stop") {
      gm.queue = [];
      gm.nowPlaying = null;
      gm.player.stop(true);

      return safeReply(message, { embeds: [xEmbed("Stopped", "Stopped music & cleared queue.", true)] });
    }

    if (cmd === "pause") {
      gm.player.pause();
      return safeReply(message, { embeds: [xEmbed("Paused", "Music paused.", true)] });
    }

    if (cmd === "resume") {
      gm.player.unpause();
      return safeReply(message, { embeds: [xEmbed("Resumed", "Music resumed.", true)] });
    }

    if (cmd === "loop") {
      gm.loop = !gm.loop;
      return safeReply(message, {
        embeds: [xEmbed("Loop", `Loop is now **${gm.loop ? "ON" : "OFF"}**`, true)],
      });
    }

    if (cmd === "shuffle") {
      if (gm.queue.length < 2) return safeReply(message, { embeds: [xEmbed("Error", "Not enough tracks to shuffle.", false)] });

      const first = gm.queue[0];
      const rest = gm.queue.slice(1);

      for (let i = rest.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [rest[i], rest[j]] = [rest[j], rest[i]];
      }

      gm.queue = [first, ...rest];
      return safeReply(message, { embeds: [xEmbed("Shuffled", "Queue shuffled.", true)] });
    }

    if (cmd === "queue") {
      if (!gm.queue.length) return safeReply(message, { embeds: [xEmbed("Queue", "Queue is empty.", true)] });

      const list = gm.queue
        .slice(0, 10)
        .map((t, i) => `**${i + 1}.** ${t.title}`)
        .join("\n");

      return safeReply(message, {
        embeds: [xEmbed("Queue", list, true)],
      });
    }

    if (cmd === "np") {
      if (!gm.nowPlaying) return safeReply(message, { embeds: [xEmbed("Now Playing", "Nothing is playing.", true)] });

      return safeReply(message, {
        embeds: [
          xEmbed(
            "Now Playing",
            `${EMOJI.music} **${gm.nowPlaying.title}**\n🔗 ${gm.nowPlaying.url}`,
            true
          ),
        ],
      });
    }
  } catch (err) {
    console.log("Message error:", err);
  }
});

// =================== INTERACTIONS (WHITELIST PANEL SELECT) ===================
client.on("interactionCreate", async (interaction) => {
  try {
    if (!interaction.isStringSelectMenu()) return;
    if (interaction.customId !== "wl_select") return;

    await interaction.reply({
      ephemeral: true,
      embeds: [
        xEmbed(
          "Selected",
          `You selected: **${interaction.values[0]}**\nNow use:\n\`${PREFIX}wl add @user ${interaction.values[0]}\``,
          true
        ),
      ],
    });
  } catch (e) {
    console.log("Interaction error:", e);
  }
});

// =================== REACTION ROLE (optional ready) ===================
client.on("messageReactionAdd", async (reaction, user) => {
  try {
    if (user.bot) return;
    if (reaction.partial) await reaction.fetch().catch(() => null);

    const msg = reaction.message;
    if (!msg.guild) return;

    const row = db
      .prepare("SELECT roleId FROM reaction_roles WHERE guildId=? AND messageId=? AND emoji=?")
      .get(msg.guild.id, msg.id, reaction.emoji.name);

    if (!row) return;

    const member = await msg.guild.members.fetch(user.id);
    await member.roles.add(row.roleId).catch(() => null);
  } catch (e) {
    console.log("RR add error:", e);
  }
});

client.on("messageReactionRemove", async (reaction, user) => {
  try {
    if (user.bot) return;
    if (reaction.partial) await reaction.fetch().catch(() => null);

    const msg = reaction.message;
    if (!msg.guild) return;

    const row = db
      .prepare("SELECT roleId FROM reaction_roles WHERE guildId=? AND messageId=? AND emoji=?")
      .get(msg.guild.id, msg.id, reaction.emoji.name);

    if (!row) return;

    const member = await msg.guild.members.fetch(user.id);
    await member.roles.remove(row.roleId).catch(() => null);
  } catch (e) {
    console.log("RR remove error:", e);
  }
});

// =================== LOGIN ===================
client.login(TOKEN);
