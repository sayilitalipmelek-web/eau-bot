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
const sendMsg = async (msg) => {
  try {
    await bot.telegram.sendMessage(GROUP_ID, msg, { disable_web_page_preview: true });
  } catch (err) {
    console.error("Telegram send error:", err.message);
  }
};

/* === Provider === */
const provider = new ethers.JsonRpcProvider(RPC_URL, { name: "pepe-unchained", chainId: CHAIN_ID });

/* === ABIs === */
const ROUTER_ABI  = ["function factory() view returns (address)"];
const FACTORY_ABI = ["function getPair(address,address) view returns (address)"];
const PAIR_ABI    = [
  "event Swap(address indexed sender,uint amount0In,uint amount1In,uint amount0Out,uint amount1Out,address indexed to)",
  "function token0() view returns (address)",
  "function token1() view returns (address)"
];
const ERC20_ABI   = ["function decimals() view returns (uint8)", "function symbol() view returns (string)"];

/* === Helper === */
function safeToNum(value, decimals = 18) {
  try {
    if (!value || value === "0" || value === 0n) return 0;
    const big = BigInt(value.toString());
    const num = Number(ethers.formatUnits(big, decimals));
    return Number.isFinite(num) && num > 0 ? num : 0;
  } catch {
    return 0;
  }
}

/* === Pair Info === */
async function getPairInfo() {
  const router = new ethers.Contract(ROUTER, ROUTER_ABI, provider);
  const factory = new ethers.Contract(await router.factory(), FACTORY_ABI, provider);
  const pairAddr = await factory.getPair(WPEPU, TOKEN);
  if (!pairAddr || pairAddr === ethers.ZeroAddress)
    throw new Error("❌ Kein gültiges Pair gefunden!");

  const pair = new ethers.Contract(pairAddr, PAIR_ABI, provider);
  const token0 = (await pair.token0()).toLowerCase();
  const tokenIs0 = TOKEN.toLowerCase() === token0;

  const token = new ethers.Contract(TOKEN, ERC20_ABI, provider);
  const base  = new ethers.Contract(WPEPU, ERC20_ABI, provider);
  const [decT, symT] = await Promise.all([token.decimals(), token.symbol()]);
  const [decW, symW] = await Promise.all([base.decimals(), base.symbol()]);

  return { pair, pairAddr, tokenIs0, decT, symT, decW, symW };
}

/* === Watcher (nur Käufe) === */
async function startWatcher() {
  const net = await provider.getNetwork();
  console.log(`✅ Verbunden mit Chain ${Number(net.chainId)}`);

  const { pair, pairAddr, tokenIs0, decT, symT, decW, symW } = await getPairInfo();
  await sendMsg(`🟢 **EAU Buy-Watcher gestartet**\nPair: \`${pairAddr}\``);

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
        let parsed;
        try { parsed = pair.interface.parseLog(log); }
        catch { continue; }

        const a = parsed.args;
        const a0In  = a.amount0In  ?? 0n;
        const a1In  = a.amount1In  ?? 0n;
        const a0Out = a.amount0Out ?? 0n;
        const a1Out = a.amount1Out ?? 0n;

        let isBuy = false, inAmt = 0n, outAmt = 0n;
        if (tokenIs0) { // token0 = EAU
          isBuy = a1In > 0n && a0Out > 0n;
          inAmt = a1In; outAmt = a0Out;
        } else { // token1 = EAU
          isBuy = a0In > 0n && a1Out > 0n;
          inAmt = a0In; outAmt = a1Out;
        }
        if (!isBuy) continue;

        const eau   = safeToNum(outAmt, decT);
        const wpepu = safeToNum(inAmt,  decW);
        if (eau <= 0 || wpepu <= 0) continue;

        const txUrl = `https://pepuscan.com/tx/${log.transactionHash}`;
        await sendMsg(`🟢 **BUY erkannt**\n${eau.toFixed(4)} ${symT} für ${wpepu.toFixed(4)} ${symW}\n🔗 ${txUrl}`);
      }

      last = current;
    } catch (err) {
      console.error("Watcher error:", err?.message || err);
    }
  }, 7000);
}

/* === Telegram Commands === */
bot.start((ctx)=> ctx.reply("EAU Buy-Watcher läuft ✅"));
bot.command('status', async (ctx)=>{
  const b = await provider.getBlockNumber().catch(()=>0);
  ctx.reply(`📡 Chain ${CHAIN_ID} | Block ${b}`);
});

/* === Start === */
bot.launch({ dropPendingUpdates: true })
  .then(async ()=> {
    console.log("🤖 Bot gestartet...");
    await startWatcher().catch(e => sendMsg(`⚠️ Startfehler: ${e.message}`));
  })
  .catch(e => console.error("Bot start error:", e.message));

/* === Keep-alive für Render === */
import http from 'http';
const PORT = Number(process.env.PORT || 10000);
http.createServer((_,res)=>{res.writeHead(200);res.end('ok');}).listen(PORT,()=>console.log(`HTTP alive :${PORT}`));
