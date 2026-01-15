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
} = require("@discordjs/voice");

const play = require("play-dl");
const express = require("express");
const Database = require("better-sqlite3");
require("dotenv").config();

// ===================== RENDER SERVER =====================
const app = express();
app.get("/", (req, res) => res.send("Bot is Secure & Online ✅"));
app.listen(process.env.PORT || 10000);

// ===================== DATABASE =====================
const db = new Database("bot.db");
db.prepare(
  "CREATE TABLE IF NOT EXISTS whitelist (guildId TEXT, userId TEXT, category TEXT, PRIMARY KEY(guildId, userId, category))"
).run();
db.prepare(
  "CREATE TABLE IF NOT EXISTS afk (userId TEXT PRIMARY KEY, reason TEXT, timestamp INTEGER)"
).run();

// ===================== BOT INIT =====================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Message, Partials.Channel],
  allowedMentions: { repliedUser: false, parse: [] }, // NO MENTION REPLY
});

const PREFIX = process.env.PREFIX || "$";
const OWNER_ID = process.env.OWNER_ID || "";

// ===================== EMBED STYLE (XLARE LIKE) =====================
const OK = "<a:AG_ur_right:1458407389228175452>";
const NO = "<a:4NDS_wrong:1458407390419615756>";

function xEmbed(title, desc, ok = true) {
  return new EmbedBuilder()
    .setColor("#000000")
    .setTitle(`${ok ? OK : NO} ${title}`)
    .setDescription(desc || "");
}

async function safeReply(message, payload) {
  try {
    return await message.reply(payload);
  } catch {
    try {
      return await message.channel.send(payload);
    } catch {}
  }
}

// ===================== WHITELIST HELPERS =====================
function getUserWhitelist(guildId, userId) {
  return db
    .prepare("SELECT category FROM whitelist WHERE guildId = ? AND userId = ?")
    .all(guildId, userId)
    .map((r) => r.category);
}

function isWhitelisted(guildId, userId, category) {
  const list = getUserWhitelist(guildId, userId);
  return list.includes(category);
}

// ===================== PERMISSION MAP =====================
const permMap = {
  ban: { flag: PermissionsBitField.Flags.BanMembers, name: "Ban Members" },
  unban: { flag: PermissionsBitField.Flags.BanMembers, name: "Ban Members" },
  kick: { flag: PermissionsBitField.Flags.KickMembers, name: "Kick Members" },
  mute: {
    flag: PermissionsBitField.Flags.ModerateMembers,
    name: "Timeout Members",
  },
  unmute: {
    flag: PermissionsBitField.Flags.ModerateMembers,
    name: "Timeout Members",
  },
  lock: {
    flag: PermissionsBitField.Flags.ManageChannels,
    name: "Manage Channels",
  },
  unlock: {
    flag: PermissionsBitField.Flags.ManageChannels,
    name: "Manage Channels",
  },
  hide: {
    flag: PermissionsBitField.Flags.ManageChannels,
    name: "Manage Channels",
  },
  unhide: {
    flag: PermissionsBitField.Flags.ManageChannels,
    name: "Manage Channels",
  },
  purge: {
    flag: PermissionsBitField.Flags.ManageMessages,
    name: "Manage Messages",
  },
};

const modCmds = Object.keys(permMap);

// ===================== MUSIC SYSTEM =====================
const music = new Map(); // guildId => { queue, player, connection, loop }

function getGuildMusic(guildId) {
  if (!music.has(guildId)) {
    music.set(guildId, {
      queue: [],
      player: createAudioPlayer({
        behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
      }),
      connection: null,
      loop: false,
      nowPlaying: null,
    });
  }
  return music.get(guildId);
}

async function connectToVC(member, guild) {
  if (!member.voice.channel) return null;

  const connection = joinVoiceChannel({
    channelId: member.voice.channel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: true,
  });

  const gm = getGuildMusic(guild.id);
  gm.connection = connection;
  connection.subscribe(gm.player);

  return connection;
}

async function playNext(guild, message) {
  const gm = getGuildMusic(guild.id);

  if (!gm.queue.length) {
    gm.nowPlaying = null;
    return safeReply(message, {
      embeds: [xEmbed("Queue Ended", "No more songs in queue.", true)],
    });
  }

  const song = gm.queue[0];
  gm.nowPlaying = song;

  try {
    const stream = await play.stream(song.url);
    const resource = createAudioResource(stream.stream, {
      inputType: stream.type,
    });

    gm.player.play(resource);

    return safeReply(message, {
      embeds: [
        xEmbed(
          "Now Playing",
          `**${song.title}**\n🔗 ${song.url}`,
          true
        ),
      ],
    });
  } catch (e) {
    gm.queue.shift();
    return safeReply(message, {
      embeds: [xEmbed("Error", "Song stream failed. Skipping...", false)],
    });
  }
}

// auto next
client.on("ready", () => {
  console.log(`✅ ${client.user.tag} is Online (Secure Mode)`);

  client.guilds.cache.forEach((g) => {
    const gm = getGuildMusic(g.id);
    gm.player.on(AudioPlayerStatus.Idle, () => {
      if (!gm.queue.length) return;

      if (gm.loop && gm.nowPlaying) {
        // keep same song in front
      } else {
        gm.queue.shift();
      }
    });
  });
});

// ===================== COMMAND ALIASES =====================
const alias = {
  // music
  j: "join",
  join: "join",
  dc: "disconnect",
  disconnect: "disconnect",
  p: "play",
  play: "play",
  s: "skip",
  skip: "skip",
  st: "stop",
  stop: "stop",
  ps: "pause",
  pause: "pause",
  rs: "resume",
  resume: "resume",
  lp: "loop",
  loop: "loop",
  sh: "shuffle",
  shuffle: "shuffle",
  q: "queue",
  queue: "queue",
  np: "nowplaying",
  nowplaying: "nowplaying",

  // moderation
  h: "hide",
  uh: "unhide",
  l: "lock",
  ul: "unlock",
};

// ===================== SECURITY CHECK =====================
function isOwnerOrAdmin(member, authorId) {
  const isOwner = authorId === OWNER_ID;
  const isAdmin = member.permissions.has(PermissionsBitField.Flags.Administrator);
  return { isOwner, isAdmin };
}

// Prefixless moderation allowed only if user has category OR prefixless
function canUsePrefixlessMod(member, guildId, userId, cmd) {
  const { isOwner, isAdmin } = isOwnerOrAdmin(member, userId);
  if (isOwner || isAdmin) return true;

  // must have actual discord perm too
  const cfg = permMap[cmd];
  if (cfg && !member.permissions.has(cfg.flag)) return false;

  // whitelist check
  const list = getUserWhitelist(guildId, userId);
  if (list.includes(cmd)) return true;
  if (list.includes("prefixless")) return true;

  return false;
}

// ===================== MESSAGE HANDLER =====================
client.on("messageCreate", async (message) => {
  try {
    if (!message.guild || message.author.bot) return;

    const guild = message.guild;
    const member = message.member;
    const author = message.author;
    const text = message.content.trim();

    // ===================== AFK SYSTEM =====================
    const afkData = db.prepare("SELECT * FROM afk WHERE userId = ?").get(author.id);
    if (afkData) {
      db.prepare("DELETE FROM afk WHERE userId = ?").run(author.id);
      await safeReply(message, {
        embeds: [xEmbed("Welcome Back", "AFK removed.", true)],
      });
    }

    if (message.mentions.users.size > 0) {
      for (const u of message.mentions.users.values()) {
        const d = db.prepare("SELECT * FROM afk WHERE userId = ?").get(u.id);
        if (d) {
          await safeReply(message, {
            embeds: [
              xEmbed(
                "User is AFK",
                `Reason: **${d.reason}**\nSince: <t:${Math.floor(
                  d.timestamp / 1000
                )}:R>`,
                false
              ),
            ],
          });
        }
      }
    }

    // ===================== COMMAND PARSING =====================
    let cmd = null;
    let args = [];
    let isPrefixless = false;

    if (text.startsWith(PREFIX)) {
      const sliced = text.slice(PREFIX.length).trim();
      if (!sliced) return;
      args = sliced.split(/\s+/);
      cmd = (args.shift() || "").toLowerCase();
      isPrefixless = false;
    } else {
      const first = text.split(/\s+/)[0].toLowerCase();

      // AFK public prefixless
      if (first === "afk") {
        cmd = "afk";
        args = text.split(/\s+/).slice(1);
        isPrefixless = true;
      } else if (modCmds.includes(first)) {
        cmd = first;
        args = text.split(/\s+/).slice(1);
        isPrefixless = true;
      } else {
        return; // ignore normal chat
      }
    }

    cmd = alias[cmd] || cmd;

    // ===================== SECURITY VALIDATION =====================
    const { isOwner, isAdmin } = isOwnerOrAdmin(member, author.id);

    // moderation cmds strict
    if (modCmds.includes(cmd)) {
      const cfg = permMap[cmd];

      // must have discord permission always (unless owner/admin)
      if (!isOwner && !isAdmin) {
        if (!member.permissions.has(cfg.flag)) {
          return safeReply(message, {
            embeds: [
              xEmbed(
                "No Permission",
                `You need **${cfg.name}** permission to use **${cmd}**.`,
                false
              ),
            ],
          });
        }

        // if prefixless => whitelist required
        if (isPrefixless) {
          const allowed = canUsePrefixlessMod(member, guild.id, author.id, cmd);
          if (!allowed) {
            return safeReply(message, {
              embeds: [
                xEmbed(
                  "Not Whitelisted",
                  `You are not whitelisted to use prefixless **${cmd}**.`,
                  false
                ),
              ],
            });
          }
        }
      }
    }

    // ===================== COMMANDS =====================

    // ping
    if (cmd === "ping") {
      return safeReply(message, {
        embeds: [xEmbed("Pong!", `Latency: \`${client.ws.ping}ms\``, true)],
      });
    }

    // help
    if (cmd === "help") {
      return safeReply(message, {
        embeds: [
          xEmbed(
            "Help",
            `**Prefix:** \`${PREFIX}\`

**Moderation**
\`${PREFIX}ban @user [reason]\`
\`${PREFIX}mute @user [minutes]\`
\`${PREFIX}lock\` / \`${PREFIX}unlock\`
\`${PREFIX}hide\` / \`${PREFIX}unhide\`
\`${PREFIX}purge 1-100\`

**Whitelist**
\`${PREFIX}wl\` (panel)
\`${PREFIX}wl add @user <ban/mute/lock/hide/prefixless>\`
\`${PREFIX}wl remove @user <category>\`
\`${PREFIX}wl list @user\`

**AFK**
\`${PREFIX}afk [reason]\`
\`afk [reason]\` (prefixless public)

**Music**
\`${PREFIX}join\` or \`${PREFIX}j\`
\`${PREFIX}dc\`
\`${PREFIX}play <name/url>\` or \`${PREFIX}p\`
\`${PREFIX}skip\`
\`${PREFIX}stop\`
\`${PREFIX}pause\` / \`${PREFIX}resume\`
\`${PREFIX}loop\`
\`${PREFIX}shuffle\`
\`${PREFIX}queue\`
\`${PREFIX}np\``,
            true
          ),
        ],
      });
    }

    // AFK
    if (cmd === "afk") {
      const reason = args.join(" ") || "AFK";
      db.prepare("INSERT OR REPLACE INTO afk VALUES (?, ?, ?)").run(
        author.id,
        reason,
        Date.now()
      );
      return safeReply(message, {
        embeds: [xEmbed("AFK Enabled", `Reason: **${reason}**`, true)],
      });
    }

    // ===================== WHITELIST =====================
    if (cmd === "wl") {
      if (!isOwner && !isAdmin) {
        return safeReply(message, {
          embeds: [xEmbed("No Permission", "Only Admin/Owner can manage whitelist.", false)],
        });
      }

      const sub = (args[0] || "").toLowerCase();

      if (!sub) {
        const row = new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("wl_menu")
            .setPlaceholder("Select whitelist category")
            .addOptions([
              { label: "Ban", value: "ban" },
              { label: "Mute", value: "mute" },
              { label: "Lock", value: "lock" },
              { label: "Hide", value: "hide" },
              { label: "Prefixless", value: "prefixless" },
            ])
        );

        return safeReply(message, {
          embeds: [xEmbed("Whitelist Panel", "Select a category from menu.", true)],
          components: [row],
        });
      }

      if (sub === "add") {
        const target = message.mentions.users.first();
        const category = (args[2] || "").toLowerCase();

        if (!target || !category) {
          return safeReply(message, {
            embeds: [xEmbed("Usage", `${PREFIX}wl add @user <ban/mute/lock/hide/prefixless>`, false)],
          });
        }

        if (!["ban", "mute", "lock", "hide", "prefixless"].includes(category)) {
          return safeReply(message, {
            embeds: [xEmbed("Invalid Category", "Valid: ban, mute, lock, hide, prefixless", false)],
          });
        }

        db.prepare("INSERT OR REPLACE INTO whitelist VALUES (?, ?, ?)").run(
          guild.id,
          target.id,
          category
        );

        return safeReply(message, {
          embeds: [xEmbed("Whitelisted", `Added **${target.tag}** to **${category}** whitelist.`, true)],
        });
      }

      if (sub === "remove") {
        const target = message.mentions.users.first();
        const category = (args[2] || "").toLowerCase();

        if (!target || !category) {
          return safeReply(message, {
            embeds: [xEmbed("Usage", `${PREFIX}wl remove @user <category>`, false)],
          });
        }

        db.prepare("DELETE FROM whitelist WHERE guildId = ? AND userId = ? AND category = ?").run(
          guild.id,
          target.id,
          category
        );

        return safeReply(message, {
          embeds: [xEmbed("Removed", `Removed **${target.tag}** from **${category}** whitelist.`, true)],
        });
      }

      if (sub === "list") {
        const target = message.mentions.users.first() || author;
        const list = getUserWhitelist(guild.id, target.id);

        return safeReply(message, {
          embeds: [
            xEmbed(
              "Whitelist List",
              `User: **${target.tag}**\nCategories: **${list.length ? list.join(", ") : "None"}**`,
              true
            ),
          ],
        });
      }

      return safeReply(message, {
        embeds: [xEmbed("Usage", `${PREFIX}wl | ${PREFIX}wl add | ${PREFIX}wl remove | ${PREFIX}wl list`, false)],
      });
    }

    // ===================== MODERATION =====================
    if (cmd === "ban") {
      const target =
        message.mentions.members.first() || guild.members.cache.get(args[0]);

      if (!target) {
        return safeReply(message, {
          embeds: [xEmbed("Invalid User", "Mention user or provide valid ID.", false)],
        });
      }

      if (!target.bannable) {
        return safeReply(message, {
          embeds: [xEmbed("Error", "I can't ban this user (role/permissions).", false)],
        });
      }

      // hierarchy check
      if (!isOwner && target.roles.highest.position >= member.roles.highest.position) {
        return safeReply(message, {
          embeds: [xEmbed("Error", "Role hierarchy error.", false)],
        });
      }

      const reason = args.slice(1).join(" ") || "No reason";
      await target.ban({ reason });

      return safeReply(message, {
        embeds: [xEmbed("Banned", `Banned **${target.user.tag}**\nReason: **${reason}**`, true)],
      });
    }

    if (cmd === "mute") {
      const target = message.mentions.members.first();
      if (!target) {
        return safeReply(message, {
          embeds: [xEmbed("Invalid User", "Usage: `$mute @user 10`", false)],
        });
      }

      const minutes = parseInt(args[1]) || 10;
      await target.timeout(minutes * 60 * 1000, "Muted by bot");

      return safeReply(message, {
        embeds: [xEmbed("Muted", `Muted **${target.user.tag}** for **${minutes} minutes**.`, true)],
      });
    }

    if (cmd === "unmute") {
      const target = message.mentions.members.first();
      if (!target) {
        return safeReply(message, {
          embeds: [xEmbed("Invalid User", "Usage: `$unmute @user`", false)],
        });
      }

      await target.timeout(null);

      return safeReply(message, {
        embeds: [xEmbed("Unmuted", `Unmuted **${target.user.tag}**.`, true)],
      });
    }

    if (cmd === "lock") {
      await message.channel.permissionOverwrites.edit(guild.roles.everyone, {
        SendMessages: false,
      });

      return safeReply(message, {
        embeds: [xEmbed("Locked", "Channel locked for **@everyone**.", true)],
      });
    }

    if (cmd === "unlock") {
      await message.channel.permissionOverwrites.edit(guild.roles.everyone, {
        SendMessages: null,
      });

      return safeReply(message, {
        embeds: [xEmbed("Unlocked", "Channel unlocked for **@everyone**.", true)],
      });
    }

    if (cmd === "hide") {
      await message.channel.permissionOverwrites.edit(guild.roles.everyone, {
        ViewChannel: false,
      });

      return safeReply(message, {
        embeds: [xEmbed("Hidden", "Channel hidden for **@everyone**.", true)],
      });
    }

    if (cmd === "unhide") {
      await message.channel.permissionOverwrites.edit(guild.roles.everyone, {
        ViewChannel: null,
      });

      return safeReply(message, {
        embeds: [xEmbed("Unhidden", "Channel visible for **@everyone**.", true)],
      });
    }

    if (cmd === "purge") {
      const amt = parseInt(args[0]);
      if (isNaN(amt) || amt < 1 || amt > 100) {
        return safeReply(message, {
          embeds: [xEmbed("Error", "Usage: `$purge 1-100`", false)],
        });
      }

      await message.channel.bulkDelete(amt, true);

      const msg = await message.channel.send({
        embeds: [xEmbed("Purged", `Deleted **${amt}** messages.`, true)],
      });

      setTimeout(() => msg.delete().catch(() => {}), 2500);
      return;
    }

    // ===================== MUSIC =====================
    if (cmd === "join") {
      if (!member.voice.channel) {
        return safeReply(message, {
          embeds: [xEmbed("Error", "Join a voice channel first.", false)],
        });
      }

      await connectToVC(member, guild);

      return safeReply(message, {
        embeds: [xEmbed("Connected", `Joined **${member.voice.channel.name}**`, true)],
      });
    }

    if (cmd === "disconnect") {
      const conn = getVoiceConnection(guild.id);
      if (!conn) {
        return safeReply(message, {
          embeds: [xEmbed("Error", "I'm not connected in any VC.", false)],
        });
      }

      conn.destroy();

      const gm = getGuildMusic(guild.id);
      gm.queue = [];
      gm.loop = false;
      gm.nowPlaying = null;

      return safeReply(message, {
        embeds: [xEmbed("Disconnected", "Left the voice channel.", true)],
      });
    }

    if (cmd === "play") {
      const query = args.join(" ");
      if (!query) {
        return safeReply(message, {
          embeds: [xEmbed("Error", `Usage: \`${PREFIX}play <song name/url>\``, false)],
        });
      }

      if (!member.voice.channel) {
        return safeReply(message, {
          embeds: [xEmbed("Error", "Join a voice channel first.", false)],
        });
      }

      const gm = getGuildMusic(guild.id);
      await connectToVC(member, guild);

      // Search + accept direct URL
      let result = null;

      try {
        if (play.yt_validate(query) === "video") {
          const info = await play.video_info(query);
          result = {
            title: info.video_details.title,
            url: info.video_details.url,
          };
        } else {
          const search = await play.search(query, { limit: 1 });
          if (!search.length) {
            return safeReply(message, {
              embeds: [xEmbed("Error", "No results found.", false)],
            });
          }
          result = { title: search[0].title, url: search[0].url };
        }
      } catch (e) {
        return safeReply(message, {
          embeds: [xEmbed("Error", "Search failed. Try another query/url.", false)],
        });
      }

      gm.queue.push(result);

      await safeReply(message, {
        embeds: [xEmbed("Added to Queue", `**${result.title}**\n🔗 ${result.url}`, true)],
      });

      // if not playing, start
      if (gm.player.state.status !== AudioPlayerStatus.Playing) {
        return playNext(guild, message);
      }
      return;
    }

    if (cmd === "skip") {
      const gm = getGuildMusic(guild.id);
      if (!gm.queue.length) {
        return safeReply(message, {
          embeds: [xEmbed("Error", "Queue is empty.", false)],
        });
      }

      gm.loop = false;
      gm.queue.shift();
      return playNext(guild, message);
    }

    if (cmd === "stop") {
      const gm = getGuildMusic(guild.id);
      gm.queue = [];
      gm.loop = false;
      gm.nowPlaying = null;
      gm.player.stop(true);

      return safeReply(message, {
        embeds: [xEmbed("Stopped", "Music stopped & queue cleared.", true)],
      });
    }

    if (cmd === "pause") {
      const gm = getGuildMusic(guild.id);
      gm.player.pause();

      return safeReply(message, {
        embeds: [xEmbed("Paused", "Music paused.", true)],
      });
    }

    if (cmd === "resume") {
      const gm = getGuildMusic(guild.id);
      gm.player.unpause();

      return safeReply(message, {
        embeds: [xEmbed("Resumed", "Music resumed.", true)],
      });
    }

    if (cmd === "loop") {
      const gm = getGuildMusic(guild.id);
      gm.loop = !gm.loop;

      return safeReply(message, {
        embeds: [xEmbed("Loop", `Loop is now **${gm.loop ? "ON" : "OFF"}**`, true)],
      });
    }

    if (cmd === "shuffle") {
      const gm = getGuildMusic(guild.id);
      if (gm.queue.length < 2) {
        return safeReply(message, {
          embeds: [xEmbed("Error", "Not enough songs to shuffle.", false)],
        });
      }

      // keep first song (currently playing) and shuffle rest
      const first = gm.queue[0];
      const rest = gm.queue.slice(1);
      for (let i = rest.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [rest[i], rest[j]] = [rest[j], rest[i]];
      }
      gm.queue = [first, ...rest];

      return safeReply(message, {
        embeds: [xEmbed("Shuffled", "Queue shuffled.", true)],
      });
    }

    if (cmd === "queue") {
      const gm = getGuildMusic(guild.id);
      if (!gm.queue.length) {
        return safeReply(message, {
          embeds: [xEmbed("Queue", "Queue is empty.", false)],
        });
      }

      const list = gm.queue
        .slice(0, 10)
        .map((s, i) => `**${i + 1}.** ${s.title}`)
        .join("\n");

      return safeReply(message, {
        embeds: [xEmbed("Queue", list, true)],
      });
    }

    if (cmd === "nowplaying") {
      const gm = getGuildMusic(guild.id);
      if (!gm.nowPlaying) {
        return safeReply(message, {
          embeds: [xEmbed("Now Playing", "Nothing is playing.", false)],
        });
      }

      return safeReply(message, {
        embeds: [
          xEmbed(
            "Now Playing",
            `**${gm.nowPlaying.title}**\n🔗 ${gm.nowPlaying.url}`,
            true
          ),
        ],
      });
    }

    // unknown command (only if prefix used)
    if (!isPrefixless) {
      return safeReply(message, {
        embeds: [xEmbed("Unknown Command", `Use \`${PREFIX}help\``, false)],
      });
    }
  } catch (e) {
    console.error(e);
    return safeReply(message, {
      embeds: [xEmbed("Error", "Something went wrong. Check logs.", false)],
    });
  }
});

// ===================== WHITELIST MENU =====================
client.on("interactionCreate", async (i) => {
  try {
    if (!i.isStringSelectMenu()) return;
    if (i.customId !== "wl_menu") return;

    const isOwner = i.user.id === OWNER_ID;
    const isAdmin = i.member.permissions.has(PermissionsBitField.Flags.Administrator);

    if (!isOwner && !isAdmin) {
      return i.reply({ content: "<a:4NDS_wrong:1458407390419615756> No Perms", ephemeral: true });
    }

    return i.reply({
      content: `<a:AG_ur_right:1458407389228175452> Selected: **${i.values[0]}**\nNow use: \`${PREFIX}wl add @user ${i.values[0]}\``,
      ephemeral: true,
    });
  } catch (e) {
    console.error(e);
  }
});

// ===================== LOGIN =====================
client.login(process.env.DISCORD_TOKEN);
