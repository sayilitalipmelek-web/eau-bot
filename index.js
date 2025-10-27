// index.js
import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { ethers } from 'ethers';

/* ============== ENV CHECK ============== */
const NEED = ["BOT_TOKEN","GROUP_ID","RPC_URL","CHAIN_ID","TOKEN","WPEPU","ROUTER"];
for (const k of NEED) {
  if (!process.env[k]) throw new Error(`❌ ENV fehlt: ${k}`);
}

const BOT_TOKEN = process.env.BOT_TOKEN;
const GROUP_ID  = process.env.GROUP_ID;
const RPC_URL   = process.env.RPC_URL;
const CHAIN_ID  = Number(process.env.CHAIN_ID);
const TOKEN     = process.env.TOKEN;
const WPEPU     = process.env.WPEPU;
const ROUTER    = process.env.ROUTER;

/* ============== TELEGRAM ============== */
const bot = new Telegraf(BOT_TOKEN);
const sendTG = async (text) => {
  try { await bot.telegram.sendMessage(GROUP_ID, text, { disable_web_page_preview: true }); }
  catch (e) { console.error("Telegram send error:", e?.message || e); }
};

/* ============== PROVIDER ============== */
const provider = new ethers.JsonRpcProvider(RPC_URL, { name: 'pepe-unchained', chainId: CHAIN_ID });

/* ============== ABIs ============== */
const ROUTER_ABI  = [ "function factory() view returns (address)" ];
const FACTORY_ABI = [ "function getPair(address tokenA,address tokenB) view returns (address)" ];
const PAIR_ABI    = [
  "event Swap(address indexed sender,uint amount0In,uint amount1In,uint amount0Out,uint amount1Out,address indexed to)",
  "function token0() view returns (address)",
  "function token1() view returns (address)"
];
const ERC20_ABI   = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)"
];

/* ============== UTIL ============== */
const toNum = (v, decimals) => {
  try {
    if (v === undefined || v === null) return NaN;
    // ethers v6 formatUnits erwartet bigint-like
    const n = Number(ethers.formatUnits(v, decimals ?? 18));
    return Number.isFinite(n) ? n : NaN;
  } catch { return NaN; }
};

/* ============== PAIR AUFLÖSEN ============== */
async function getPairInfo() {
  const router   = new ethers.Contract(ROUTER, ROUTER_ABI, provider);
  const factoryA = await router.factory();
  const factory  = new ethers.Contract(factoryA, FACTORY_ABI, provider);

  const pairA = await factory.getPair(WPEPU, TOKEN);
  if (!pairA || pairA === ethers.ZeroAddress) {
    throw new Error("⚠️ Pair (WPEPU/EAU) nicht gefunden – existiert LP?");
  }

  const pair = new ethers.Contract(pairA, PAIR_ABI, provider);

  const [t0, t1] = [(await pair.token0()).toLowerCase(), (await pair.token1()).toLowerCase()];
  const tokenIs0 = TOKEN.toLowerCase() === t0;

  const t = new ethers.Contract(TOKEN, ERC20_ABI, provider);
  const w = new ethers.Contract(WPEPU, ERC20_ABI, provider);
  const [decT, symT] = await Promise.all([t.decimals(), t.symbol()]);
  const [decW, symW] = await Promise.all([w.decimals(), w.symbol()]);

  return { pair, pairAddr: pairA, tokenIs0, decT, symT, decW, symW };
}

/* ============== WATCHER (nur Käufe) ============== */
async function startWatcher() {
  const net = await provider.getNetwork();
  console.log(`✅ Verbunden: ${net.name} (chainId ${Number(net.chainId)})`);

  const { pair, pairAddr, tokenIs0, decT, symT, decW, symW } = await getPairInfo();
  await sendTG(`🟢 **EAU Buy-Watcher aktiv**\nPair: \`${pairAddr}\``);

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

      for (const lg of logs) {
        // Parse Swap
        let args;
        try { args = pair.interface.parseLog(lg).args; }
        catch { continue; }

        // Extract amounts safe (fallback 0n)
        const a0In  = (args.amount0In  ?? 0n);
        const a1In  = (args.amount1In  ?? 0n);
        const a0Out = (args.amount0Out ?? 0n);
        const a1Out = (args.amount1Out ?? 0n);

        // Nur BUY: WPEPU -> EAU
        let isBuy, inAmt, outAmt;
        if (tokenIs0) {           // token0 = EAU
          isBuy  = (a1In  > 0n) && (a0Out > 0n);  // WPEPU in, EAU out
          inAmt  = a1In;
          outAmt = a0Out;
        } else {                  // token1 = EAU
          isBuy  = (a0In  > 0n) && (a1Out > 0n);  // WPEPU in, EAU out
          inAmt  = a0In;
          outAmt = a1Out;
        }
        if (!isBuy) continue;

        // Sicher formatieren (NaN/Underflow abfangen)
        const eau   = toNum(outAmt, decT);
        const wpepu = toNum(inAmt,  decW);
        if (!Number.isFinite(eau) || !Number.isFinite(wpepu) || eau <= 0 || wpepu <= 0) continue;

        const txUrl = `https://pepuscan.com/tx/${lg.transactionHash}`;
        await sendTG(
          `🟢 **BUY**\n` +
          `${eau.toFixed(4)} ${symT} für ${wpepu.toFixed(4)} ${symW}\n` +
          `🔗 ${txUrl}`
        );
      }

      last = current;
    } catch (e) {
      console.error("Watcher error:", e?.message || e);
      // nicht crashen – einfach weitermachen
    }
  }, 7000);
}

/* ============== TELEGRAM COMMANDS ============== */
bot.start((ctx)=> ctx.reply("EAU Buy-Watcher läuft ✅ (meldet nur Käufe WPEPU → EAU)."));
bot.command('status', async (ctx)=>{
  try {
    const b = await provider.getBlockNumber();
    ctx.reply(`📡 Chain ${CHAIN_ID} | Block ${b}\nÜberwacht: WPEPU → EAU`);
  } catch {
    ctx.reply(`📡 Chain ${CHAIN_ID} | Status unbekannt (RPC geprüft).`);
  }
});
bot.command('ping', (ctx)=> ctx.reply('pong ✅'));

/* ============== START ============== */
bot.launch({ dropPendingUpdates: true })
  .then(async ()=>{
    console.log("🤖 Bot gestartet…");
    try { await startWatcher(); }
    catch (e) {
      console.error("Startfehler:", e?.message || e);
      await sendTG(`⚠️ Startfehler: ${e?.message || e}`);
    }
  })
  .catch(e => console.error("Bot launch error:", e?.message || e));

/* ============== KEEP-ALIVE FÜR RENDER (optional) ============== */
import http from 'http';
const PORT = Number(process.env.PORT || 10000);
http.createServer((_, res) => { res.writeHead(200); res.end('ok'); }).listen(PORT, () =>
  console.log(`HTTP keep-alive on :${PORT}`)
);
