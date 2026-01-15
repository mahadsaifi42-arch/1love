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
  NoSubscriberBehavior,
} = require("@discordjs/voice");

const play = require("play-dl");
const express = require("express");
const Database = require("better-sqlite3");
require("dotenv").config();

// ===================== ENV =====================
const PREFIX = process.env.PREFIX || "$";
const OWNER_ID = process.env.OWNER_ID;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

if (!DISCORD_TOKEN) throw new Error("❌ Missing DISCORD_TOKEN in env");

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
  "CREATE TABLE IF NOT EXISTS afk (guildId TEXT, userId TEXT, reason TEXT, timestamp INTEGER, PRIMARY KEY(guildId, userId))"
).run();

// ===================== BOT =====================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Message, Partials.Channel],
  allowedMentions: { repliedUser: false }, // no reply ping
});

// ===================== STYLE =====================
const tick = "<a:AG_ur_right:1458407389228175452>";
const cross = "<a:4NDS_wrong:1460976888863391757>";

// no mention anywhere in replies
const NO_MENTION = { repliedUser: false, parse: [] };

function xEmbed(title, desc, ok = true) {
  return new EmbedBuilder()
    .setColor("#000000")
    .setTitle(`${ok ? tick : cross} ${title}`)
    .setDescription(desc || "");
}

function safeReply(message, payload) {
  return message.reply({
    ...payload,
    allowedMentions: NO_MENTION,
  });
}

function safeSend(channel, payload) {
  return channel.send({
    ...payload,
    allowedMentions: NO_MENTION,
  });
}

// ===================== PERMISSION MAP =====================
const permMap = {
  ban: { flag: PermissionsBitField.Flags.BanMembers, name: "Ban Members" },
  unban: { flag: PermissionsBitField.Flags.BanMembers, name: "Ban Members" },
  kick: { flag: PermissionsBitField.Flags.KickMembers, name: "Kick Members" },
  mute: {
    flag: PermissionsBitField.Flags.ModerateMembers,
    name: "Moderate Members",
  },
  unmute: {
    flag: PermissionsBitField.Flags.ModerateMembers,
    name: "Moderate Members",
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

// ===================== WHITELIST HELPERS =====================
function getUserWhitelist(guildId, userId) {
  return db
    .prepare("SELECT category FROM whitelist WHERE guildId = ? AND userId = ?")
    .all(guildId, userId)
    .map((r) => r.category);
}

// IMPORTANT: Prefixless moderation needs BOTH permission + whitelist
function canUsePrefixlessMod(member, guildId, cmd) {
  const isOwner = member.id === OWNER_ID;
  const isAdmin = member.permissions.has(PermissionsBitField.Flags.Administrator);
  if (isOwner || isAdmin) return true;

  const wl = getUserWhitelist(guildId, member.id);

  // Must have prefixless + specific category OR prefixless + cmd category
  // Example: to use prefixless ban, user must have:
  // prefixless + ban  OR  prefixless + (cmd name)
  const hasPrefixless = wl.includes("prefixless");
  const hasCmd = wl.includes(cmd);

  return hasPrefixless && hasCmd;
}

// Prefix commands: permission only (whitelist not required)
function hasDiscordPermission(member, cmd) {
  const cfg = permMap[cmd];
  if (!cfg) return true;
  return member.permissions.has(cfg.flag);
}

// ===================== READY =====================
client.on("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag} (Secure Mode ON)`);
});

// ===================== MESSAGE HANDLER =====================
client.on("messageCreate", async (message) => {
  try {
    if (!message.guild) return;
    if (message.author.bot) return;

    const { content, member, author, guild } = message;
    if (!content) return;

    const text = content.trim();
    const lower = text.toLowerCase();

    // ===================== AFK SYSTEM (PUBLIC PREFIXLESS) =====================
    // Remove AFK when user sends any message
    const myAfk = db
      .prepare("SELECT * FROM afk WHERE guildId = ? AND userId = ?")
      .get(guild.id, author.id);

    if (myAfk) {
      db.prepare("DELETE FROM afk WHERE guildId = ? AND userId = ?").run(
        guild.id,
        author.id
      );
      await safeReply(message, {
        embeds: [xEmbed("Welcome Back", "AFK removed.", true)],
      });
    }

    // If mention AFK user -> reply (no ping)
    if (message.mentions.users.size > 0) {
      for (const u of message.mentions.users.values()) {
        const afkData = db
          .prepare("SELECT * FROM afk WHERE guildId = ? AND userId = ?")
          .get(guild.id, u.id);

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

    // ===================== COMMAND PARSER =====================
    let cmd = null;
    let args = [];
    let isPrefixless = false;

    // PREFIX COMMANDS
    if (text.startsWith(PREFIX)) {
      const sliced = text.slice(PREFIX.length).trim();
      if (!sliced) return;
      args = sliced.split(/\s+/);
      cmd = (args.shift() || "").toLowerCase();
      isPrefixless = false;
    } else {
      // PREFIXLESS:
      const first = lower.split(/\s+/)[0];

      // AFK is public prefixless for everyone
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

    // ===================== BASIC COMMANDS =====================
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
\`${PREFIX}play <name/url>\``,
            true
          ),
        ],
      });
    }

    // ===================== SECURITY VALIDATION LAYER =====================
    const isOwner = author.id === OWNER_ID;
    const isAdmin = member.permissions.has(PermissionsBitField.Flags.Administrator);

    // For moderation commands: strict rules
    if (modCmds.includes(cmd)) {
      const cfg = permMap[cmd];

      // 1) Always require Discord permission unless Owner/Admin
      if (!isOwner && !isAdmin) {
        if (!hasDiscordPermission(member, cmd)) {
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
      }

      // 2) If prefixless, require whitelist (Owner/Admin bypass)
      if (isPrefixless && !isOwner && !isAdmin) {
        const allowed = canUsePrefixlessMod(member, guild.id, cmd);
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

    // ===================== COMMANDS =====================

    // AFK (prefix + prefixless)
    if (cmd === "afk") {
      const reason = args.join(" ") || "AFK";
      db.prepare(
        "INSERT OR REPLACE INTO afk (guildId, userId, reason, timestamp) VALUES (?, ?, ?, ?)"
      ).run(guild.id, author.id, reason, Date.now());

      return safeReply(message, {
        embeds: [xEmbed("AFK Enabled", `Reason: **${reason}**`, true)],
      });
    }

    // BAN
    if (cmd === "ban") {
      const target =
        message.mentions.members.first() ||
        (args[0] ? await guild.members.fetch(args[0]).catch(() => null) : null);

      if (!target) {
        return safeReply(message, {
          embeds: [xEmbed("Error", "Mention a user or provide a valid ID.", false)],
        });
      }

      if (!target.bannable) {
        return safeReply(message, {
          embeds: [
            xEmbed(
              "Error",
              "I cannot ban this user. Check my role position & permissions.",
              false
            ),
          ],
        });
      }

      const reason = args.slice(1).join(" ") || "No reason";
      await target.ban({ reason });

      return safeReply(message, {
        embeds: [xEmbed("Success", `Banned **${target.user.tag}**`, true)],
      });
    }

    // UNBAN
    if (cmd === "unban") {
      const userId = args[0];
      if (!userId) {
        return safeReply(message, {
          embeds: [xEmbed("Error", "Usage: unban <userId>", false)],
        });
      }

      await guild.members.unban(userId).catch(() => null);

      return safeReply(message, {
        embeds: [xEmbed("Success", `Unbanned user ID: **${userId}**`, true)],
      });
    }

    // KICK
    if (cmd === "kick") {
      const target = message.mentions.members.first();
      if (!target) {
        return safeReply(message, {
          embeds: [xEmbed("Error", "Mention a user to kick.", false)],
        });
      }

      if (!target.kickable) {
        return safeReply(message, {
          embeds: [
            xEmbed(
              "Error",
              "I cannot kick this user. Check my role position & permissions.",
              false
            ),
          ],
        });
      }

      const reason = args.slice(1).join(" ") || "No reason";
      await target.kick(reason);

      return safeReply(message, {
        embeds: [xEmbed("Success", `Kicked **${target.user.tag}**`, true)],
      });
    }

    // MUTE
    if (cmd === "mute") {
      const target = message.mentions.members.first();
      if (!target) {
        return safeReply(message, {
          embeds: [xEmbed("Error", "Mention a user to mute.", false)],
        });
      }

      const mins = parseInt(args[1] || "10", 10);
      const durationMs = Math.max(1, mins) * 60 * 1000;

      await target.timeout(durationMs, `Muted by ${author.tag}`).catch(() => null);

      return safeReply(message, {
        embeds: [xEmbed("Success", `Muted **${target.user.tag}** for **${mins}m**`, true)],
      });
    }

    // UNMUTE
    if (cmd === "unmute") {
      const target = message.mentions.members.first();
      if (!target) {
        return safeReply(message, {
          embeds: [xEmbed("Error", "Mention a user to unmute.", false)],
        });
      }

      await target.timeout(null, `Unmuted by ${author.tag}`).catch(() => null);

      return safeReply(message, {
        embeds: [xEmbed("Success", `Unmuted **${target.user.tag}**`, true)],
      });
    }

    // LOCK (for @everyone)
    if (cmd === "lock") {
      await message.channel.permissionOverwrites.edit(guild.roles.everyone, {
        SendMessages: false,
      });

      return safeReply(message, {
        embeds: [xEmbed("Success", "Channel locked for **@everyone**.", true)],
      });
    }

    // UNLOCK (for @everyone)
    if (cmd === "unlock") {
      await message.channel.permissionOverwrites.edit(guild.roles.everyone, {
        SendMessages: true,
      });

      return safeReply(message, {
        embeds: [xEmbed("Success", "Channel unlocked for **@everyone**.", true)],
      });
    }

    // HIDE (for @everyone)
    if (cmd === "hide") {
      await message.channel.permissionOverwrites.edit(guild.roles.everyone, {
        ViewChannel: false,
      });

      return safeReply(message, {
        embeds: [xEmbed("Success", "Channel hidden for **@everyone**.", true)],
      });
    }

    // UNHIDE (for @everyone)
    if (cmd === "unhide") {
      await message.channel.permissionOverwrites.edit(guild.roles.everyone, {
        ViewChannel: true,
      });

      return safeReply(message, {
        embeds: [xEmbed("Success", "Channel unhidden for **@everyone**.", true)],
      });
    }

    // PURGE
    if (cmd === "purge") {
      const amt = parseInt(args[0], 10);
      if (isNaN(amt) || amt < 1 || amt > 100) {
        return safeReply(message, {
          embeds: [xEmbed("Error", "Amount must be between 1 and 100.", false)],
        });
      }

      await message.channel.bulkDelete(amt, true).catch(() => null);

      const msg = await safeSend(message.channel, {
        embeds: [xEmbed("Success", `Purged **${amt}** messages.`, true)],
      });
      setTimeout(() => msg.delete().catch(() => {}), 3000);
      return;
    }

    // WL PANEL / ADD / REMOVE / LIST
    if (cmd === "wl") {
      if (!isOwner && !isAdmin) return;

      const sub = (args[0] || "").toLowerCase();

      if (sub === "list") {
        const rows = db
          .prepare("SELECT userId, category FROM whitelist WHERE guildId = ?")
          .all(guild.id);

        if (!rows.length) {
          return safeReply(message, {
            embeds: [xEmbed("Whitelist", "No whitelist entries found.", true)],
          });
        }

        const text = rows
          .slice(0, 40)
          .map((r) => `• **${r.category}** → \`${r.userId}\``)
          .join("\n");

        return safeReply(message, {
          embeds: [xEmbed("Whitelist", text, true)],
        });
      }

      if (sub === "add") {
        const target = message.mentions.users.first();
        const category = (args[2] || "").toLowerCase();

        if (!target || !category) {
          return safeReply(message, {
            embeds: [
              xEmbed(
                "Usage",
                `Use: \`${PREFIX}wl add @user <ban/mute/prefixless/advertise/spam/lock/purge/hide>\``,
                false
              ),
            ],
          });
        }

        db.prepare(
          "INSERT OR REPLACE INTO whitelist (guildId, userId, category) VALUES (?, ?, ?)"
        ).run(guild.id, target.id, category);

        return safeReply(message, {
          embeds: [
            xEmbed(
              "Whitelist Updated",
              `Added **${target.tag}** to **${category}**`,
              true
            ),
          ],
        });
      }

      if (sub === "remove") {
        const target = message.mentions.users.first();
        const category = (args[2] || "").toLowerCase();

        if (!target || !category) {
          return safeReply(message, {
            embeds: [
              xEmbed(
                "Usage",
                `Use: \`${PREFIX}wl remove @user <category>\``,
                false
              ),
            ],
          });
        }

        db.prepare(
          "DELETE FROM whitelist WHERE guildId = ? AND userId = ? AND category = ?"
        ).run(guild.id, target.id, category);

        return safeReply(message, {
          embeds: [
            xEmbed(
              "Whitelist Updated",
              `Removed **${target.tag}** from **${category}**`,
              true
            ),
          ],
        });
      }

      // default panel
      const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("wl_menu")
          .setPlaceholder("Select Category")
          .addOptions([
            { label: "Ban", value: "ban" },
            { label: "Mute", value: "mute" },
            { label: "Prefixless", value: "prefixless" },
            { label: "Lock", value: "lock" },
            { label: "Hide", value: "hide" },
            { label: "Purge", value: "purge" },
            { label: "Advertise", value: "advertise" },
            { label: "Spam", value: "spam" },
          ])
      );

      return safeReply(message, {
        embeds: [
          xEmbed(
            "Whitelist Panel",
            `Select a category.\nThen use:\n\`${PREFIX}wl add @user <category>\``,
            true
          ),
        ],
        components: [row],
      });
    }

    // MUSIC: play
    if (cmd === "play") {
      if (!member.voice.channel) {
        return safeReply(message, {
          embeds: [xEmbed("Error", "Join a voice channel first.", false)],
        });
      }

      const query = args.join(" ");
      if (!query) {
        return safeReply(message, {
          embeds: [xEmbed("Error", `Usage: ${PREFIX}play <song name/url>`, false)],
        });
      }

      const connection = joinVoiceChannel({
        channelId: member.voice.channel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
      });

      const search = await play.search(query, { limit: 1 });
      if (!search.length) {
        return safeReply(message, {
          embeds: [xEmbed("Error", "No results found.", false)],
        });
      }

      const stream = await play.stream(search[0].url);
      const player = createAudioPlayer({
        behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
      });

      player.play(createAudioResource(stream.stream, { inputType: stream.type }));
      connection.subscribe(player);

      return safeReply(message, {
        embeds: [xEmbed("Music", `Playing: **${search[0].title}**`, true)],
      });
    }

    // If command not matched -> ignore silently
    return;
  } catch (e) {
    console.error(e);
    try {
      return safeReply(message, {
        embeds: [
          xEmbed(
            "Error",
            "Something went wrong. Check bot permissions / role position.",
            false
          ),
        ],
      });
    } catch {}
  }
});

// ===================== WL MENU INTERACTION =====================
client.on("interactionCreate", async (i) => {
  try {
    if (!i.isStringSelectMenu()) return;
    if (i.customId !== "wl_menu") return;

    const isOwner = i.user.id === OWNER_ID;
    const isAdmin = i.member.permissions.has(PermissionsBitField.Flags.Administrator);
    if (!isOwner && !isAdmin) {
      return i.reply({ content: "<a:4NDS_wrong:1460976888863391757> No Permission", ephemeral: true });
    }

    const selected = i.values[0];
    return i.reply({
      content: `<a:AG_ur_right:1458407389228175452> Selected: **${selected}**\nNow use: \`${PREFIX}wl add @user ${selected}\``,
      ephemeral: true,
    });
  } catch (e) {
    console.error(e);
  }
});

client.login(DISCORD_TOKEN);
