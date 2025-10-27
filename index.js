// index.js
import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { ethers } from 'ethers';

/* === ENV check === */
const REQ = ["BOT_TOKEN","GROUP_ID","RPC_URL","CHAIN_ID","TOKEN","WPEPU","ROUTER"];
for (const k of REQ) if (!process.env[k]) throw new Error(`❌ ENV fehlt: ${k}`);

const BOT_TOKEN = process.env.BOT_TOKEN;
const GROUP_ID  = process.env.GROUP_ID;
const RPC_URL   = process.env.RPC_URL;
const CHAIN_ID  = Number(process.env.CHAIN_ID);
const TOKEN     = process.env.TOKEN;
const WPEPU     = process.env.WPEPU;
const ROUTER    = process.env.ROUTER;

/* === Telegram === */
const bot = new Telegraf(BOT_TOKEN);
async function sendMsg(text) {
  try {
    await bot.telegram.sendMessage(GROUP_ID, text, { disable_web_page_preview: true });
  } catch (err) {
    console.error("Telegram send error:", err?.message || err);
  }
}

/* === Provider === */
const provider = new ethers.JsonRpcProvider(RPC_URL, { name: "pepe-unchained", chainId: CHAIN_ID });

/* === ABIs === */
const ROUTER_ABI  = ["function factory() view returns (address)"];
const FACTORY_ABI = ["function getPair(address tokenA,address tokenB) view returns (address)"];
const PAIR_ABI    = [
  "event Swap(address indexed sender,uint amount0In,uint amount1In,uint amount0Out,uint amount1Out,address indexed to)",
  "function token0() view returns (address)",
  "function token1() view returns (address)"
];
const ERC20_ABI   = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)"
];

/* === Helper === */
function safeFormat(value, decimals = 18) {
  try {
    if (value === undefined || value === null) return 0;
    const n = parseFloat(ethers.formatUnits(value, decimals));
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/* === Pair === */
async function getPair() {
  const router = new ethers.Contract(ROUTER, ROUTER_ABI, provider);
  const factoryAddr = await router.factory();
  const factory = new ethers.Contract(factoryAddr, FACTORY_ABI, provider);
  const pairAddr = await factory.getPair(WPEPU, TOKEN);

  if (!pairAddr || pairAddr === ethers.ZeroAddress)
    throw new Error("⚠️ Kein Pair für WPEPU/EAU gefunden!");

  const pair = new ethers.Contract(pairAddr, PAIR_ABI, provider);
  const token0 = (await pair.token0()).toLowerCase();
  const tokenIs0 = TOKEN.toLowerCase() === token0;

  const t = new ethers.Contract(TOKEN, ERC20_ABI, provider);
  const w = new ethers.Contract(WPEPU, ERC20_ABI, provider);
  const [decT, symT] = await Promise.all([t.decimals(), t.symbol()]);
  const [decW, symW] = await Promise.all([w.decimals(), w.symbol()]);

  return { pair, pairAddr, tokenIs0, decT, symT, decW, symW };
}

/* === Watcher (nur Käufe) === */
async function startWatcher() {
  const net = await provider.getNetwork();
  console.log(`✅ Verbunden: ${net.name} (chainId ${Number(net.chainId)})`);

  const { pair, pairAddr, tokenIs0, decT, symT, decW, symW } = await getPair();
  await sendMsg(`🟢 **EAU Buy-Watcher aktiv**\nPair: \`${pairAddr}\``);

  let last = await provider.getBlockNumber();

  setInterval(async () => {
    try {
      const current = await provider.getBlockNumber();
      if (current <= last) return;

      const logs = await provider.getLogs({
        address: pairAddr,
        topics: [ethers.id("Swap(address,uint256,uint256,uint256,uint256,address)")],
        fromBlock: last + 1,
        toBlock: current
      });

      for (const log of logs) {
        let args;
        try { args = pair.interface.parseLog(log).args; }
        catch { continue; }

        const a0In  = args.amount0In  ?? 0n;
        const a1In  = args.amount1In  ?? 0n;
        const a0Out = args.amount0Out ?? 0n;
        const a1Out = args.amount1Out ?? 0n;

        let isBuy = false, inAmt = 0n, outAmt = 0n;
        if (tokenIs0) {
          isBuy  = (a1In > 0n && a0Out > 0n);
          inAmt  = a1In;
          outAmt = a0Out;
        } else {
          isBuy  = (a0In > 0n && a1Out > 0n);
          inAmt  = a0In;
          outAmt = a1Out;
        }
        if (!isBuy) continue;

        const eau   = safeFormat(outAmt, decT);
        const wpepu = safeFormat(inAmt,  decW);
        if (!eau || !wpepu) continue;

        const tx = `https://pepuscan.com/tx/${log.transactionHash}`;
        await sendMsg(
          `🟢 **BUY erkannt**\n` +
          `${eau.toFixed(4)} ${symT} für ${wpepu.toFixed(4)} ${symW}\n` +
          `🔗 ${tx}`
        );
      }

      last = current;
    } catch (err) {
      console.error("Watcher error:", err?.message || err);
    }
  }, 7000);
}

/* === Telegram Commands === */
bot.start((ctx)=> ctx.reply("EAU Buy-Watcher läuft ✅ (meldet nur Käufe WPEPU → EAU)."));
bot.command('status', async (ctx)=>{
  const b = await provider.getBlockNumber().catch(()=>0);
  ctx.reply(`📡 Chain ${CHAIN_ID} | Block ${b}\nÜberwacht: WPEPU → EAU`);
});

/* === Start === */
bot.launch({ dropPendingUpdates: true })
  .then(async ()=>{
    console.log("🤖 Bot gestartet…");
    await startWatcher().catch(e => sendMsg(`⚠️ Startfehler: ${e?.message || e}`));
  })
  .catch(e => console.error("Bot launch error:", e?.message || e));

/* === Keep alive === */
import http from 'http';
const PORT = Number(process.env.PORT || 10000);
http.createServer((_, res) => { res.writeHead(200); res.end('ok'); }).listen(PORT);
