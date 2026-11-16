// A small emoji picker: the common ones, each found by a short English word or two.
// ponytail: ~250 hand-picked emojis, no full Unicode table - add more words here when asked.
import { h } from "./util.js";
import { emojiSets, canDraw } from "./spaces.js";

const LIST = `😀 smile happy|😃 grin|😄 laugh|😁 beam|😆 lol|😅 sweat phew|🤣 rofl|😂 joy tears|🙂 slight|🙃 upside|😉 wink|😊 blush|😇 angel halo|🥰 love hearts|😍 heart eyes|🤩 star struck|😘 kiss|😋 yum tasty|😛 tongue|😜 crazy|🤪 zany|🤑 money|🤗 hug|🤭 oops|🤫 shh quiet|🤔 think hmm|🤐 zip|🤨 doubt|😐 neutral|😑 blank|😶 silent|😏 smirk|😒 unamused|🙄 eyeroll|😬 grimace|😌 relieved|😔 pensive|😪 sleepy|😴 sleep zzz|😷 mask sick|🤒 fever ill|🤕 hurt|🤢 nausea|🤮 vomit|🥵 hot|🥶 cold freeze|🥴 woozy|😵 dizzy|🤯 mind blown|🤠 cowboy|🥳 party|😎 cool sunglasses|🤓 nerd|🧐 monocle|😕 confused|😟 worried|🙁 frown|😮 wow|😯 hushed|😲 shock|😳 flushed|🥺 plead please|😦 frown open|😧 anguish|😨 fear|😰 anxious|😥 sad relief|😢 cry|😭 sob|😱 scream|😖 confound|😣 persevere|😞 disappointed|😓 downcast|😩 weary|😫 tired|🥱 yawn|😤 huff|😡 angry rage|😠 mad|🤬 swear|😈 devil|💀 skull dead|💩 poop|🤡 clown|👻 ghost|👽 alien|🤖 robot|😺 cat smile|🙈 see no evil|🙉 hear no|🙊 speak no|💋 kiss mark|💌 love letter|❤️ heart red love|🧡 orange heart|💛 yellow heart|💚 green heart|💙 blue heart|💜 purple heart|🖤 black heart|🤍 white heart|💔 broken heart|❣️ heart exclaim|💕 two hearts|💯 hundred 100|💢 anger|💥 boom bang|💫 dizzy star|💦 sweat drops|💨 dash fast|💬 speech chat|💭 thought|👋 wave hi bye|🤚 hand raised|✋ stop hand|🖖 vulcan|👌 ok|🤌 pinch|✌️ peace victory|🤞 fingers crossed luck|🤟 love you|🤘 rock|🤙 call me|👈 left|👉 right|👆 up|👇 down|☝️ point|👍 thumbs up yes like|👎 thumbs down no|✊ fist|👊 punch|👏 clap|🙌 raise hands yay|👐 open hands|🤲 palms|🤝 handshake deal|🙏 pray thanks please|✍️ write|💪 muscle strong gym|🧠 brain|👀 eyes look|👁️ eye|👶 baby|🧒 child|👦 boy|👧 girl|🧑 person|👨 man|👩 woman|🧓 old|🙋 raise hand|🤷 shrug|🤦 facepalm|🏃 run|🚶 walk|🧘 yoga meditate|🏋️ lift weights|🚴 bike cycle|🏊 swim|⚽ soccer football|🏀 basketball|🏈 american football|⚾ baseball|🎾 tennis|🏐 volleyball|🏆 trophy win|🥇 gold first|🥈 silver|🥉 bronze|🎯 target goal|🎮 game|🎲 dice|🎵 music note|🎶 music notes|🎧 headphones|🎤 mic|🎸 guitar|🎹 piano|🎬 movie film|📷 camera photo|🎨 art paint|📚 books read|📖 book|📝 memo note|✏️ pencil|🖊️ pen|📌 pin|📎 clip|📅 calendar date|📆 calendar|🗓️ planner|⏰ alarm|⏳ hourglass wait|⌛ time|⏱️ stopwatch timer|🕐 clock|💡 idea bulb|🔥 fire hot lit|⭐ star|🌟 glow star|✨ sparkles|⚡ zap lightning|☀️ sun|🌙 moon night|☁️ cloud|🌧️ rain|❄️ snow|🌈 rainbow|🌊 wave sea|🌍 earth world|🌱 sprout grow|🌳 tree|🌸 blossom flower|🌹 rose|🌻 sunflower|🍀 clover luck|🍁 leaf maple|🐶 dog|🐱 cat|🐭 mouse|🐰 rabbit|🦊 fox|🐻 bear|🐼 panda|🐨 koala|🐯 tiger|🦁 lion|🐮 cow|🐷 pig|🐸 frog|🐵 monkey|🐔 chicken|🐧 penguin|🐦 bird|🦄 unicorn|🐝 bee|🦋 butterfly|🐢 turtle|🐍 snake|🐙 octopus|🐟 fish|🐬 dolphin|🐳 whale|🍎 apple|🍌 banana|🍓 strawberry|🍇 grapes|🍉 watermelon|🍋 lemon|🥑 avocado|🥦 broccoli|🥕 carrot|🍞 bread|🧀 cheese|🥚 egg|🍳 cook|🍔 burger|🍟 fries|🍕 pizza|🌮 taco|🍣 sushi|🍜 ramen noodles|🍰 cake|🎂 birthday|🍪 cookie|🍫 chocolate|🍿 popcorn|☕ coffee|🍵 tea|🥤 drink|🍺 beer|🍷 wine|🥂 cheers|💧 water drop|🏠 home house|🏢 office|🏫 school|🏥 hospital|🚗 car|🚕 taxi|🚌 bus|🚆 train|✈️ plane flight travel|🚀 rocket launch ship|🛸 ufo|⛵ boat|🗺️ map|🧭 compass|⛰️ mountain|🏖️ beach|💻 laptop computer|🖥️ desktop|⌨️ keyboard|🖱️ mouse click|📱 phone|☎️ telephone|🔋 battery|🔌 plug|💾 save disk|📁 folder|📂 open folder|📄 page doc|📊 chart bar|📈 up trend growth|📉 down trend|📋 clipboard|📦 package box|✉️ mail email|📧 email|📮 postbox|🔔 bell notify|🔕 mute|🔍 search find|🔒 lock|🔓 unlock|🔑 key|🛠️ tools|🔧 wrench fix|🔨 hammer|⚙️ gear settings|🧪 test lab|🧲 magnet|💰 money bag|💵 dollar cash|💳 card|💎 gem diamond|🎁 gift present|🎉 tada party celebrate|🎊 confetti|🎈 balloon|🏁 finish flag|🚩 red flag|✅ check done yes|☑️ checkbox|✔️ tick|❌ cross no wrong|❎ cross box|➕ plus add|➖ minus|❓ question|❗ exclaim important|⚠️ warning|🚫 forbidden|⛔ no entry|♻️ recycle|🔴 red circle|🟠 orange circle|🟡 yellow circle|🟢 green circle|🔵 blue circle|🟣 purple circle|⚫ black circle|⚪ white circle|➡️ arrow right|⬅️ arrow left|⬆️ arrow up|⬇️ arrow down|🔁 repeat|🔄 refresh|🆕 new|🆗 ok button|🔝 top|💤 zzz`
  .split("|").map((s) => { const i = s.indexOf(" "); return { e: s.slice(0, i), w: s.slice(i + 1) }; });

const bare = (e) => e.replace(/\ufe0f/g, "");
const WORDS = new Map(LIST.map((x) => [bare(x.e), x.w.split(" ")]));
/** The short English words for an emoji ([] when it has none). */
export const emojiWords = (e) => WORDS.get(bare(e)) || [];

let close = null;
let drawn = null; // the named ones this system paints, found once
const RECENT = "leonote-emoji-recent";
const recent = () => { try { return JSON.parse(localStorage.getItem(RECENT) || "[]"); } catch { return []; } };

/** Opens the picker at (x, y); onPick(emoji) inserts it. */
export function emojiPicker(x, y, onPick, { keep = false } = {}) {
  if (close) close();
  const grid = h("div", { class: "emo-grid" });
  const input = h("input", { class: "emo-find", placeholder: "Find: heart, fire, check…", spellcheck: "false" });
  const pick = (e) => {
    try { localStorage.setItem(RECENT, JSON.stringify([e, ...recent().filter((x) => x !== e)].slice(0, 16))); } catch {}
    if (!keep) close();
    onPick(e);
  };
  const paint = () => {
    const q = input.value.trim().toLowerCase();
    const rec = recent();
    const named = drawn || (drawn = LIST.filter((x) => canDraw(x.e)));
    const seen = new Set(named.map((x) => bare(x.e)));
    const rest = (all || []).filter((e) => !seen.has(bare(e))).map((e) => ({ e, w: "" }));
    const list = q ? named.filter((x) => x.w.split(" ").some((w) => w.startsWith(q)) || x.w.includes(q)) : [...rec.map((e) => ({ e, w: "recent" })), ...named.filter((x) => !rec.includes(x.e)), ...rest];
    grid.replaceChildren(...list.map((x) => h("button", { class: "emo", title: x.w, onclick: () => pick(x.e) }, x.e)));
    if (!list.length) grid.append(h("div", { class: "emo-none", text: "No emoji by that word" }));
  };
  let all = null;
  emojiSets().then((r) => { all = r.all; if (!input.value) paint(); });
  input.addEventListener("input", paint);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
    if (e.key === "Enter") { const b = grid.querySelector(".emo"); if (b) b.click(); }
  });
  const pop = h("div", { class: "menu emo-pop is-in" }, input, grid);
  document.getElementById("overlay-root").append(pop);
  const r = pop.getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + "px";
  pop.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + "px";
  const away = (e) => { if (!pop.contains(e.target)) close(); };
  close = () => { pop.remove(); document.removeEventListener("mousedown", away, true); close = null; };
  setTimeout(() => document.addEventListener("mousedown", away, true));
  paint();
  input.focus();
}
