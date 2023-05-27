const dotenv = require("dotenv");

const { Telegraf, Markup } = require("telegraf");
const { message, editedMessage } = require("telegraf/filters");

const LocalSession = require("telegraf-session-local");

const TogglTrackAPI = require("./toggl_track_api");

dotenv.config();

const localSession = new LocalSession({
  database: "data/sessions.json",
  state: { check: [] },
});

const bot = new Telegraf(process.env.BOT_TOKEN);

bot.use(localSession.middleware());

// localSession.DB
// bot.use(session({
//     defaultSession: (ctx) => {counter: 0},
// }));

const humanDuration = (seconds) => {
  let hours = Math.floor(seconds / 3600);
  seconds -= hours * 3600;
  hours = hours ? `${hours}h ` : "";
  let minutes = Math.floor(seconds / 60);
  seconds -= minutes * 60;
  minutes = minutes ? `${minutes}m ` : "";
  seconds = seconds ? `${seconds}s ` : "";
  return `${hours}${minutes}${seconds}ago`;
};

function initSession(session) {
  if (!("tokens" in session)) {
    session.tokens = {};
  }
}

function checkHasToken(ctx) {
  if (ctx.session.tokens.length) {
    return true;
  }
  ctx.reply("Provide a token first");
  return false;
}

async function checkHandler(ctx) {
  if (!checkHasToken(ctx)) {
    return;
  }
  const token = ctx.session.tokens[0].token;
  const currentTimer = await TogglTrackAPI.currentTimer(token);
  if (!currentTimer) {
    ctx.reply("Timer is not started");
    return;
  }
  ctx.session.tokens[0].lastDuration = currentTimer.duration;

  const now = Math.floor(Date.now() / 1000);
  const duration = humanDuration(now + currentTimer.duration); // duration - negative unix timestamp
  const reply_markup = Markup.inlineKeyboard([
    Markup.button.callback("Start regular checking", "start_checking"),
  ]);
  ctx.reply(`Timer was started for ${duration}`, reply_markup);
}

bot.use(async (ctx, next) => {
  const title = `Processing update ${ctx.update.update_id}`;
  console.time(title);
  if (ctx.chat.type === "private") {
    initSession(ctx.session);
    console.log(ctx.session);
    await next();
  } else {
    ctx.reply("Incorrect chat type");
  }
  console.timeEnd(title);
});

bot.start((ctx) => {
  ctx.reply(
    "Send me a token.\n" +
      "You can find it here: https://track.toggl.com/profile#api-token"
  );
});

bot.hears(/^[0-9a-z]{32}$/i, async (ctx) => {
  const token = ctx.message.text;
  if (ctx.session.tokens.length) {
    if (token === ctx.session.tokens[0].token) {
      ctx.reply("The same token is already stored", {
        reply_to_message_id: ctx.message.message_id,
      });
      return;
    }
  }
  ctx.telegram.sendChatAction(ctx.chat.id, "typing");
  const togglUser = await TogglTrackAPI.me(token);
  if (!togglUser) {
    ctx.reply("Seems like incorrect token...", {
      reply_to_message_id: ctx.message.message_id,
    });
    return;
  }
  ctx.session.tokens = [
    {
      token: token,
      username: togglUser.fullname,
    },
  ];
  const reply_markup = Markup.inlineKeyboard([
    Markup.button.callback("Check timer now", "check"),
  ]);
  ctx.reply(`Valid token for "${togglUser.fullname}"`, reply_markup);
});
bot.action("check", checkHandler);

bot.command("check", checkHandler);
bot.action("start_checking", (ctx) => {
  ctx.answerCbQuery("Starting");
});

bot.command("stop", (ctx) => {
  ctx.reply("TODO:");
});

bot.command("status", (ctx) => {
  ctx.reply("TODO:");
});

bot.command("edit", (ctx) => {
  ctx.reply("Simply send me a new token, I will replace the old one with it");
});

bot.command("delete", (ctx) => {
  if (!ctx.session.tokens.length) {
    ctx.reply("Nothing to delete");
    return;
  }
  ctx.session.tokens = [];
  ctx.reply("Token deleted");
});

bot.on(editedMessage(), (ctx) => {
  ctx.reply("Editing messages is not supported");
});

bot.settings(async (ctx) => {
  await ctx.telegram.setMyCommands([
    {
      command: "/start",
      description: "Start bot",
    },
    {
      command: "/check",
      description: "Start timer checking for the saved token",
    },
    {
      command: "/status",
      description: "What is the current status of the checking",
    },
    {
      command: "/stop",
      description: "Stop current check",
    },
    {
      command: "/edit",
      description: "How to edit a token",
    },
    {
      command: "/delete",
      description: "Delete token from memory",
    },
  ]);
  ctx.reply("Ok");
});

bot.help(async (ctx) => {
  const commands = await ctx.telegram.getMyCommands();
  if (!commands.length) {
    ctx.reply("I can't help");
    return;
  }
  const text = commands.reduce(
    (acc, val) => `${acc}/${val.command} - ${val.description}\n`,
    ""
  );
  ctx.reply(text);
});

bot.on(message(), (ctx) => {
  ctx.reply("Unknown command, use /help");
});

bot.launch({
  dropPendingUpdates: false,
  allowedUpdates: ["message", "edited_message", "callback_query"],
});

// Enable graceful stop
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
