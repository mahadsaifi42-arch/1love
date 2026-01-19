require("dotenv").config();

const { Client, GatewayIntentBits } = require("discord.js");
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
} = require("@discordjs/voice");

const { spawn } = require("child_process");
const ffmpeg = require("ffmpeg-static");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

const player = createAudioPlayer({
  behaviors: { noSubscriber: NoSubscriberBehavior.Play },
});

player.on("error", (e) => console.log("PLAYER ERROR:", e));

const FILTERS = [
  "volume=2.5",
  "equalizer=f=80:t=q:w=1.0:g=8",
  "equalizer=f=200:t=q:w=1.0:g=4",
  "acompressor=threshold=0.2:ratio=10:attack=5:release=100:makeup=6",
  "alimiter=limit=0.95:level=0.95",
].join(",");

function playLoop(connection) {
  const ff = spawn(ffmpeg, [
    "-re",
    "-i",
    "packing.mp3",
    "-af",
    FILTERS,
    "-f",
    "s16le",
    "-ar",
    "48000",
    "-ac",
    "2",
    "pipe:1",
  ]);

  ff.on("error", (e) => console.log("FFMPEG ERROR:", e));
  ff.stderr.on("data", (d) => {}); // silent

  const resource = createAudioResource(ff.stdout, { inputType: StreamType.Raw });
  player.play(resource);
  connection.subscribe(player);
}

client.on("messageCreate", async (m) => {
  if (m.author.bot) return;

  if (m.content === "!pack") {
    const vc = m.member?.voice?.channel;
    if (!vc) return m.reply("❌ VC join kar pehle!");

    const connection = joinVoiceChannel({
      channelId: vc.id,
      guildId: vc.guild.id,
      adapterCreator: vc.guild.voiceAdapterCreator,
      selfDeaf: false,
    });

    playLoop(connection);

    player.removeAllListeners(AudioPlayerStatus.Idle);
    player.on(AudioPlayerStatus.Idle, () => playLoop(connection));

    return m.reply("🔊 Playing packing.mp3 (LOUD)");
  }

  if (m.content === "!stop") {
    player.stop();
    return m.reply("🛑 Stopped.");
  }
});

client.login(process.env.TOKEN);
