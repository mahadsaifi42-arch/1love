const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  PermissionsBitField,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  Partials,
} = require("discord.js");

const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  getVoiceConnection,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
} = require("@discordjs/voice");

const play = require("play-dl");
const express = require("express");
const Database = require("better-sqlite3");
require("dotenv").config();

// ====================== DATABASE ======================
const db = new Database("bot.db");

db.prepare(
  "CREATE TABLE IF NOT EXISTS whitelist (guildId TEXT, userId TEXT, category TEXT, PRIMARY KEY(guildId, userId, category))"
).run();

db.prepare(
  "CREATE TABLE IF NOT EXISTS afk (userId TEXT PRIMARY KEY, reason TEXT, timestamp INTEGER)"
).run();

// ====================== RENDER SERVER ======================
const app = express();
app.get("/", (req, res) => res.send("Bot is Secure & Online ✅"));
app.listen(process.env.PORT || 10000);

// ====================== BOT ======================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Message, Partials.Channel],
  allowedMentions: { repliedUser: false }, // mention off
});

const PREFIX = process.env.PREFIX || "$";
const OWNER_ID = process.env.OWNER_ID || "";
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || "";

// ====================== XLARE LOOK ======================
const EMOJI = {
  ok: "<a:AG_ur_right:1458407389228175452>",
  no: "<a:B_ERROR:1316750242389037057>",
  lock: "<a:lock_keyggchillhaven:1460976890981650526>",
  music: "<a:Music:1460976894194352192>",
};

function xEmbed(title, desc, ok = true) {
  return new EmbedBuilder()
    .setColor("#000000")
    .setTitle(`${ok ? EMOJI.ok : EMOJI.no} ${title}`)
    .setDescription(desc);
}

function safeReply(message, payload) {
  return message.reply({
    ...payload,
    allowedMentions: { repliedUser: false },
  });
}

// ====================== PERMISSION MAP ======================
const permMap = {
  ban: { flag: PermissionsBitField.Flags.BanMembers, name: "Ban Members" },
  unban: { flag: PermissionsBitField.Flags.BanMembers, name: "Ban Members" },
  kick: { flag: PermissionsBitField.Flags.KickMembers, name: "Kick Members" },
  mute: { flag: PermissionsBitField.Flags.ModerateMembers, name: "Moderate Members" },
  unmute: { flag: PermissionsBitField.Flags.ModerateMembers, name: "Moderate Members" },
  lock: { flag: PermissionsBitField.Flags.ManageChannels, name: "Manage Channels" },
  unlock: { flag: PermissionsBitField.Flags.ManageChannels, name: "Manage Channels" },
  hide: { flag: PermissionsBitField.Flags.ManageChannels, name: "Manage Channels" },
  unhide: { flag: PermissionsBitField.Flags.ManageChannels, name: "Manage Channels" },
  purge: { flag: PermissionsBitField.Flags.ManageMessages, name: "Manage Messages" },
};

const modCmds = Object.keys(permMap);

// ====================== WHITELIST HELPERS ======================
function getUserWhitelist(guildId, userId) {
  return db
    .prepare("SELECT category FROM whitelist WHERE guildId = ? AND userId = ?")
    .all(guildId, userId)
    .map((r) => r.category);
}

function canUsePrefixless(member, guildId, cmd) {
  // Owner/Admin always allowed
  const isOwner = member.id === OWNER_ID;
  const isAdmin = member.permissions.has(PermissionsBitField.Flags.Administrator);
  if (isOwner || isAdmin) return true;

  const wl = getUserWhitelist(guildId, member.id);
  // allow if user has exact cmd OR "prefixless"
  return wl.includes(cmd) || wl.includes("prefixless");
}

// ====================== MUSIC SYSTEM ======================
const musicState = new Map();
// guildId => { queue: [], player, connection, loop, nowPlaying }

function getGuildMusic(guildId) {
  if (!musicState.has(guildId)) {
    const player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });

    musicState.set(guildId, {
      queue: [],
      player,
      connection: null,
      loop: false,
      nowPlaying: null,
      playing: false,
    });

    player.on(AudioPlayerStatus.Idle, async () => {
      const state = musicState.get(guildId);
      if (!state) return;

      if (state.loop && state.nowPlaying) {
        // replay same track
        await playTrack(guildId, state.nowPlaying).catch(() => {});
        return;
      }

      // next track
      state.nowPlaying = null;
      state.playing = false;
      playNext(guildId).catch(() => {});
    });

    player.on("error", (err) => {
      console.log("Music Player Error:", err?.message);
      const state = musicState.get(guildId);
      if (state) {
        state.nowPlaying = null;
        state.playing = false;
      }
      playNext(guildId).catch(() => {});
    });
  }
  return musicState.get(guildId);
}

async function ensureVC(message) {
  const { guild, member } = message;
  if (!member.voice.channel) {
    await safeReply(message, {
      embeds: [xEmbed("Error", "Join a voice channel first.", false)],
    });
    return null;
  }

  const state = getGuildMusic(guild.id);

  if (!state.connection) {
    state.connection = joinVoiceChannel({
      channelId: member.voice.channel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
    });

    state.connection.subscribe(state.player);
  }

  return state;
}

async function playTrack(guildId, track) {
  const state = getGuildMusic(guildId);
  state.nowPlaying = track;
  state.playing = true;

  // stream using play-dl
  const stream = await play.stream(track.url);
  const resource = createAudioResource(stream.stream, {
    inputType: stream.type || StreamType.Arbitrary,
  });

  state.player.play(resource);
}

async function playNext(guildId) {
  const state = getGuildMusic(guildId);
  if (!state) return;
  if (state.playing) return;

  const next = state.queue.shift();
  if (!next) return;

  try {
    await playTrack(guildId, next);
  } catch (e) {
    console.log("Failed to play track:", e?.message);
    state.nowPlaying = null;
    state.playing = false;
    // skip to next
    await playNext(guildId);
  }
}

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// ====================== READY ======================
client.on("ready", async () => {
  console.log(`✅ ${client.user.tag} Online`);

  // Optional: YouTube cookie (fixes many "Failed to play" issues)
  if (process.env.YT_COOKIE) {
    try {
      await play.setToken({
        youtube: { cookie: process.env.YT_COOKIE },
      });
      console.log("✅ YT_COOKIE Loaded");
    } catch (e) {
      console.log("❎ YT_COOKIE Failed:", e?.message);
    }
  } else {
    console.log("⚠️ No YT_COOKIE (music may fail sometimes on Render)");
  }
});

// ====================== INTERACTIONS (WL MENU) ======================
client.on("interactionCreate", async (i) => {
  if (!i.isStringSelectMenu()) return;
  if (i.customId !== "wl_menu") return;

  const isOwner = i.user.id === OWNER_ID;
  const isAdmin = i.member.permissions.has(PermissionsBitField.Flags.Administrator);
  if (!isOwner && !isAdmin) {
    return i.reply({ content: "No Permission", ephemeral: true });
  }

  return i.reply({
    content: `Selected: **${i.values[0]}**\nNow use:\n\`${PREFIX}wl add @user ${i.values[0]}\``,
    ephemeral: true,
  });
});

// ====================== MESSAGE CREATE ======================
client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot || !message.guild) return;

    const { content, guild, member, author } = message;
    const text = content.trim();

    // ====================== AFK SYSTEM ======================
    const myAfk = db.prepare("SELECT * FROM afk WHERE userId = ?").get(author.id);
    if (myAfk) {
      db.prepare("DELETE FROM afk WHERE userId = ?").run(author.id);
      await safeReply(message, { embeds: [xEmbed("Welcome Back", "AFK removed.", true)] });
    }

    if (message.mentions.users.size > 0) {
      for (const u of message.mentions.users.values()) {
        const afkData = db.prepare("SELECT * FROM afk WHERE userId = ?").get(u.id);
        if (afkData) {
          await safeReply(message, {
            embeds: [
              xEmbed(
                "User is AFK",
                `Reason: **${afkData.reason}**\nSince: <t:${Math.floor(
                  afkData.timestamp / 1000
                )}:R>`,
                false
              ),
            ],
          });
        }
      }
    }

    // ====================== ALIASES ======================
    const alias = {
      // music short cmds
      j: "join",
      dc: "disconnect",
      p: "play",
      s: "skip",
      st: "stop",
      ps: "pause",
      rs: "resume",
      lp: "loop",
      sh: "shuffle",
      q: "queue",
      np: "nowplaying",
    };

    // ====================== COMMAND PARSE ======================
    let cmd = null;
    let args = [];
    let isPrefixless = false;

    // Prefix commands
    if (text.startsWith(PREFIX)) {
      const sliced = text.slice(PREFIX.length).trim();
      if (!sliced) return;
      args = sliced.split(/\s+/);
      cmd = (args.shift() || "").toLowerCase();
      isPrefixless = false;
    } else {
      // Prefixless only for AFK + modCmds + music shortcuts (whitelisted)
      const first = text.split(/\s+/)[0].toLowerCase();

      // AFK is public prefixless
      if (first === "afk") {
        cmd = "afk";
        args = text.split(/\s+/).slice(1);
        isPrefixless = true;
      } else if (
        modCmds.includes(first) ||
        ["join", "disconnect", "play", "skip", "stop", "pause", "resume", "loop", "shuffle", "queue", "nowplaying"].includes(first) ||
        Object.keys(alias).includes(first)
      ) {
        cmd = first;
        args = text.split(/\s+/).slice(1);
        isPrefixless = true;
      } else {
        return; // ignore normal chat
      }
    }

    // alias apply
    cmd = alias[cmd] || cmd;

    const isOwner = author.id === OWNER_ID;
    const isAdmin = member.permissions.has(PermissionsBitField.Flags.Administrator);

    // ====================== SECURITY LAYER (STRICT) ======================
    // Moderation commands always require Discord permissions
    if (modCmds.includes(cmd)) {
      const cfg = permMap[cmd];

      // Owner/Admin bypass
      if (!isOwner && !isAdmin) {
        // must have discord permission
        if (!member.permissions.has(cfg.flag)) {
          return safeReply(message, {
            embeds: [xEmbed("No Permission", `You need **${cfg.name}** permission.`, false)],
          });
        }

        // prefixless requires whitelist
        if (isPrefixless) {
          const allowed = canUsePrefixless(member, guild.id, cmd);
          if (!allowed) {
            return safeReply(message, {
              embeds: [xEmbed("Not Whitelisted", `You can't use prefixless **${cmd}**.`, false)],
            });
          }
        }
      }
    }

    // Music prefixless requires whitelist too (except owner/admin)
    const musicCmds = ["join", "disconnect", "play", "skip", "stop", "pause", "resume", "loop", "shuffle", "queue", "nowplaying"];
    if (musicCmds.includes(cmd)) {
      if (isPrefixless && !isOwner && !isAdmin) {
        const allowed = canUsePrefixless(member, guild.id, "prefixless");
        if (!allowed) {
          return safeReply(message, {
            embeds: [xEmbed("Not Whitelisted", "You can't use prefixless music commands.", false)],
          });
        }
      }
    }

    // ====================== COMMANDS ======================
    // Basic
    if (cmd === "ping") {
      return safeReply(message, {
        embeds: [xEmbed("Pong!", `Latency: \`${client.ws.ping}ms\``, true)],
      });
    }

    if (cmd === "help") {
      return safeReply(message, {
        embeds: [
          xEmbed(
            "Help",
            `**Prefix:** \`${PREFIX}\`

**Moderation**
\`${PREFIX}ban @user\`
\`${PREFIX}mute @user 10\`
\`${PREFIX}lock\` / \`${PREFIX}unlock\`
\`${PREFIX}hide\` / \`${PREFIX}unhide\`

**Whitelist**
\`${PREFIX}wl\` (panel)
\`${PREFIX}wl add @user <category>\`
\`${PREFIX}wl list\`

**AFK**
\`${PREFIX}afk reason\`
\`afk reason\` (public)

**Music**
\`${PREFIX}join\` / \`${PREFIX}dc\`
\`${PREFIX}play <name/url>\`
\`${PREFIX}skip\` \`${PREFIX}stop\`
\`${PREFIX}pause\` \`${PREFIX}resume\`
\`${PREFIX}loop\` \`${PREFIX}shuffle\`
\`${PREFIX}queue\` \`${PREFIX}np\`
`,
            true
          ),
        ],
      });
    }

    // AFK
    if (cmd === "afk") {
      const reason = args.join(" ") || "AFK";
      db.prepare("INSERT OR REPLACE INTO afk VALUES (?, ?, ?)").run(author.id, reason, Date.now());
      return safeReply(message, {
        embeds: [xEmbed("AFK Enabled", `Reason: **${reason}**`, true)],
      });
    }

    // Whitelist
    if (cmd === "wl") {
      if (!isOwner && !isAdmin) return;

      const sub = (args[0] || "").toLowerCase();

      if (sub === "add") {
        const target = message.mentions.users.first();
        const category = (args[2] || "").toLowerCase();

        if (!target || !category) {
          return safeReply(message, {
            embeds: [xEmbed("Error", `Usage: \`${PREFIX}wl add @user <category>\``, false)],
          });
        }

        db.prepare("INSERT OR REPLACE INTO whitelist VALUES (?, ?, ?)").run(guild.id, target.id, category);
        return safeReply(message, {
          embeds: [xEmbed("Whitelisted", `Added **${target.tag}** to **${category}**`, true)],
        });
      }

      if (sub === "list") {
        const rows = db
          .prepare("SELECT userId, category FROM whitelist WHERE guildId = ?")
          .all(guild.id);

        if (!rows.length) {
          return safeReply(message, { embeds: [xEmbed("Whitelist", "No users whitelisted.", true)] });
        }

        const textList = rows
          .map((r) => `• <@${r.userId}> → **${r.category}**`)
          .slice(0, 30)
          .join("\n");

        return safeReply(message, {
          embeds: [xEmbed("Whitelist", textList, true)],
        });
      }

      // panel
      const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("wl_menu")
          .setPlaceholder("Select Category")
          .addOptions([
            { label: "Ban", value: "ban" },
            { label: "Mute", value: "mute" },
            { label: "Lock", value: "lock" },
            { label: "Unlock", value: "unlock" },
            { label: "Hide", value: "hide" },
            { label: "Unhide", value: "unhide" },
            { label: "Prefixless (ALL)", value: "prefixless" },
          ])
      );

      return safeReply(message, {
        embeds: [xEmbed("Whitelist Panel", "Select a category from menu.", true)],
        components: [row],
      });
    }

    // ====================== MODERATION ======================
    if (cmd === "ban") {
      const target = message.mentions.members.first() || guild.members.cache.get(args[0]);
      if (!target) {
        return safeReply(message, { embeds: [xEmbed("Error", "Mention user or provide ID.", false)] });
      }

      if (!target.bannable) {
        return safeReply(message, { embeds: [xEmbed("Error", "I can't ban this user (role higher than me).", false)] });
      }

      // hierarchy check (member vs target)
      if (!isOwner && target.roles.highest.position >= member.roles.highest.position) {
        return safeReply(message, { embeds: [xEmbed("Error", "Role hierarchy error.", false)] });
      }

      await target.ban({ reason: `Banned by ${author.tag}` });
      return safeReply(message, { embeds: [xEmbed("Banned", `**${target.user.tag}** banned successfully.`, true)] });
    }

    if (cmd === "mute") {
      const target = message.mentions.members.first() || guild.members.cache.get(args[0]);
      if (!target) {
        return safeReply(message, { embeds: [xEmbed("Error", "Mention user or provide ID.", false)] });
      }

      if (!target.moderatable) {
        return safeReply(message, { embeds: [xEmbed("Error", "I can't mute this user (role higher than me).", false)] });
      }

      const minutes = parseInt(args[1] || "10");
      const durationMs = (isNaN(minutes) ? 10 : minutes) * 60 * 1000;

      await target.timeout(durationMs, `Muted by ${author.tag}`);
      return safeReply(message, {
        embeds: [xEmbed("Muted", `Muted **${target.user.tag}** for **${minutes}m**`, true)],
      });
    }

    if (cmd === "unmute") {
      const target = message.mentions.members.first() || guild.members.cache.get(args[0]);
      if (!target) {
        return safeReply(message, { embeds: [xEmbed("Error", "Mention user or provide ID.", false)] });
      }

      await target.timeout(null, `Unmuted by ${author.tag}`);
      return safeReply(message, {
        embeds: [xEmbed("Unmuted", `Unmuted **${target.user.tag}**`, true)],
      });
    }

    if (cmd === "lock") {
      await message.channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false });
      return safeReply(message, { embeds: [xEmbed("Locked", "Channel locked for **@everyone**.", true)] });
    }

    if (cmd === "unlock") {
      await message.channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: true });
      return safeReply(message, { embeds: [xEmbed("Unlocked", "Channel unlocked for **@everyone**.", true)] });
    }

    if (cmd === "hide") {
      await message.channel.permissionOverwrites.edit(guild.roles.everyone, { ViewChannel: false });
      return safeReply(message, { embeds: [xEmbed("Hidden", "Channel hidden for **@everyone**.", true)] });
    }

    if (cmd === "unhide") {
      await message.channel.permissionOverwrites.edit(guild.roles.everyone, { ViewChannel: true });
      return safeReply(message, { embeds: [xEmbed("Unhidden", "Channel visible for **@everyone**.", true)] });
    }

    if (cmd === "purge") {
      const amt = parseInt(args[0]);
      if (isNaN(amt) || amt < 1 || amt > 100) {
        return safeReply(message, { embeds: [xEmbed("Error", "Amount must be 1-100", false)] });
      }
      await message.channel.bulkDelete(amt, true);
      const m = await message.channel.send({ embeds: [xEmbed("Purged", `Deleted **${amt}** messages.`, true)] });
      setTimeout(() => m.delete().catch(() => {}), 3000);
      return;
    }

    // ====================== MUSIC ======================
    if (cmd === "join") {
      const state = await ensureVC(message);
      if (!state) return;
      return safeReply(message, {
        embeds: [xEmbed("Connected", `Joined **${member.voice.channel.name}**`, true)],
      });
    }

    if (cmd === "disconnect") {
      const conn = getVoiceConnection(guild.id);
      if (!conn) {
        return safeReply(message, { embeds: [xEmbed("Error", "I'm not connected in any VC.", false)] });
      }
      conn.destroy();
      const state = getGuildMusic(guild.id);
      state.queue = [];
      state.nowPlaying = null;
      state.playing = false;
      state.connection = null;

      return safeReply(message, { embeds: [xEmbed("Disconnected", "Left the voice channel.", true)] });
    }

    if (cmd === "play") {
      const query = args.join(" ");
      if (!query) {
        return safeReply(message, {
          embeds: [xEmbed("Error", `Usage: \`${PREFIX}play <song name/url>\``, false)],
        });
      }

      const state = await ensureVC(message);
      if (!state) return;

      let result = null;

      // if URL
      if (play.yt_validate(query) === "video") {
        const info = await play.video_basic_info(query);
        result = {
          title: info.video_details.title,
          url: info.video_details.url,
        };
      } else {
        const search = await play.search(query, { limit: 1 });
        if (!search.length) {
          return safeReply(message, { embeds: [xEmbed("Error", "No results found.", false)] });
        }
        result = { title: search[0].title, url: search[0].url };
      }

      state.queue.push(result);

      await safeReply(message, {
        embeds: [
          xEmbed(
            "Added to Queue",
            `${EMOJI.music} **${result.title}**\n🔗 ${result.url}`,
            true
          ),
        ],
      });

      // start if not playing
      if (!state.playing && !state.nowPlaying) {
        await playNext(guild.id);
      }

      return;
    }

    if (cmd === "skip") {
      const state = getGuildMusic(guild.id);
      if (!state.connection) {
        return safeReply(message, { embeds: [xEmbed("Error", "I'm not in VC.", false)] });
      }
      state.player.stop();
      return safeReply(message, { embeds: [xEmbed("Skipped", "Skipped current track.", true)] });
    }

    if (cmd === "stop") {
      const state = getGuildMusic(guild.id);
      state.queue = [];
      state.loop = false;
      state.player.stop();
      return safeReply(message, { embeds: [xEmbed("Stopped", "Stopped music & cleared queue.", true)] });
    }

    if (cmd === "pause") {
      const state = getGuildMusic(guild.id);
      state.player.pause();
      return safeReply(message, { embeds: [xEmbed("Paused", "Paused playback.", true)] });
    }

    if (cmd === "resume") {
      const state = getGuildMusic(guild.id);
      state.player.unpause();
      return safeReply(message, { embeds: [xEmbed("Resumed", "Resumed playback.", true)] });
    }

    if (cmd === "loop") {
      const state = getGuildMusic(guild.id);
      state.loop = !state.loop;
      return safeReply(message, {
        embeds: [xEmbed("Loop", `Loop is now: **${state.loop ? "ON" : "OFF"}**`, true)],
      });
    }

    if (cmd === "shuffle") {
      const state = getGuildMusic(guild.id);
      if (!state.queue.length) {
        return safeReply(message, { embeds: [xEmbed("Error", "Queue is empty.", false)] });
      }
      shuffleArray(state.queue);
      return safeReply(message, { embeds: [xEmbed("Shuffled", "Queue shuffled.", true)] });
    }

    if (cmd === "queue") {
      const state = getGuildMusic(guild.id);
      if (!state.nowPlaying && !state.queue.length) {
        return safeReply(message, { embeds: [xEmbed("Queue", "Queue is empty.", true)] });
      }

      const now = state.nowPlaying ? `**Now:** ${state.nowPlaying.title}\n\n` : "";
      const list = state.queue
        .slice(0, 10)
        .map((t, i) => `\`${i + 1}.\` ${t.title}`)
        .join("\n");

      return safeReply(message, {
        embeds: [xEmbed("Queue", `${now}${list || ""}`, true)],
      });
    }

    if (cmd === "nowplaying") {
      const state = getGuildMusic(guild.id);
      if (!state.nowPlaying) {
        return safeReply(message, { embeds: [xEmbed("Now Playing", "Nothing playing.", false)] });
      }
      return safeReply(message, {
        embeds: [
          xEmbed(
            "Now Playing",
            `${EMOJI.music} **${state.nowPlaying.title}**\n🔗 ${state.nowPlaying.url}`,
            true
          ),
        ],
      });
    }
  } catch (e) {
    console.error(e);
    return;
  }
});

// ====================== LOGIN ======================
client.login(DISCORD_TOKEN);
