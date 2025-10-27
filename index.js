// index.js
import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { ethers } from 'ethers';

/* ===== ENV check ===== */
const REQ = ["BOT_TOKEN","GROUP_ID","RPC_URL","CHAIN_ID","TOKEN","WPEPU","ROUTER"];
for (const k of REQ) if (!process.env[k]) throw new Error(`❌ ENV fehlt: ${k}`);

const BOT_TOKEN = process.env.BOT_TOKEN;
const GROUP_ID  = process.env.GROUP_ID;
const RPC_URL   = process.env.RPC_URL;
const CHAIN_ID  = Number(process.env.CHAIN_ID);
const TOKEN     = process.env.TOKEN;
const WPEPU     = process.env.WPEPU;
const ROUTER    = process.env.ROUTER;

/* ===== Telegram ===== */
const bot = new Telegraf(BOT_TOKEN);

/* ===== Provider ===== */
const provider = new ethers.JsonRpcProvider(RPC_URL, {
  name: "pepe-unchained",
  chainId: CHAIN_ID
});

/* ===== ABIs ===== */
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

/* ===== Helpers ===== */
async function safeSend(text) {
  try {
    await bot.telegram.sendMessage(GROUP_ID, text, { disable_web_page_preview: true });
  } catch (e) {
    console.error("Telegram send error:", e?.message || e);
  }
}

/* ===== Pair ermitteln ===== */
async function resolvePair() {
  const router = new ethers.Contract(ROUTER, ROUTER_ABI, provider);
  const factoryAddr = await router.factory();
  const factory = new ethers.Contract(factoryAddr, FACTORY_ABI, provider);

  const pairAddr = await factory.getPair(WPEPU, TOKEN);
  if (!pairAddr || pairAddr === ethers.ZeroAddress) {
    throw new Error("⚠️ Pair (WPEPU/EAU) nicht gefunden – existiert LP?");
  }

  const pair = new ethers.Contract(pairAddr, PAIR_ABI, provider);
  const token0 = (await pair.token0()).toLowerCase();
  const tokenIs0 = TOKEN.toLowerCase() === token0;

  const tCt = new ethers.Contract(TOKEN, ERC20_ABI, provider);
  const wCt = new ethers.Contract(WPEPU, ERC20_ABI, provider);
  const [decT, symT] = await Promise.all([tCt.decimals(), tCt.symbol()]);
  const [decW, symW] = await Promise.all([wCt.decimals(), wCt.symbol()]);

  return { pair, pairAddr, tokenIs0, decT, symT, decW, symW };
}

/* ===== Watcher: nur Käufe ===== */
async function startWatcher() {
  const net = await provider.getNetwork();
  console.log(`✅ Verbunden: ${net.name} (chainId ${Number(net.chainId)})`);

  const { pair, pairAddr, tokenIs0, decT, symT, decW, symW } = await resolvePair();
  await safeSend(`🟢 **EAU Buy-Watcher aktiv**\nPair: \`${pairAddr}\``);

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
        // robustes Parsing
        let args;
        try { args = pair.interface.parseLog(lg).args; } catch { continue; }

        let isBuy = false, inAmt = 0n, outAmt = 0n;
        try {
          if (tokenIs0) {
            // Buy: WPEPU in, TOKEN (EAU) out
            isBuy = (args.amount1In ?? 0n) > 0n && (args.amount0Out ?? 0n) > 0n;
            inAmt  = args.amount1In ?? 0n;
            outAmt = args.amount0Out ?? 0n;
          } else {
            isBuy = (args.amount0In ?? 0n) > 0n && (args.amount1Out ?? 0n) > 0n;
            inAmt  = args.amount0In ?? 0n;
            outAmt = args.amount1Out ?? 0n;
          }
        } catch { continue; }

        if (!isBuy) continue;

        // Zahlen sicher formatieren
        let eauNum, wpepuNum;
        try {
          eauNum   = Number(ethers.formatUnits(outAmt, decT || 18));
          wpepuNum = Number(ethers.formatUnits(inAmt,  decW || 18));
        } catch { continue; }
        if (!Number.isFinite(eauNum) || !Number.isFinite(wpepuNum) || eauNum <= 0 || wpepuNum <= 0) continue;

        const txUrl = `https://pepuscan.com/tx/${lg.transactionHash}`;
        await safeSend(
          `🟢 **BUY erkannt**\n` +
          `${eauNum.toFixed(4)} ${symT} für ${wpepuNum.toFixed(4)} ${symW}\n` +
          `🔗 ${txUrl}`
        );
      }

      last = current;
    } catch (e) {
      console.error("Watcher error:", e?.message || e);
    }
  }, 7000); // 7s Polling
}

/* ===== Telegram Commands ===== */
bot.start((ctx)=> ctx.reply("EAU Buy-Watcher läuft ✅ (meldet nur Käufe)."));
bot.command('status', async (ctx)=>{
  const b = await provider.getBlockNumber().catch(()=>0);
  ctx.reply(`📡 Chain ${CHAIN_ID} | Block ${b}\nÜberwacht: WPEPU → EAU`);
});

/* ===== Start ===== */
bot.launch({ dropPendingUpdates: true })
  .then(async ()=>{
    console.log("🤖 Bot gestartet…");
    await startWatcher().catch(async e=>{
      console.error("Startfehler:", e?.message || e);
      await safeSend(`⚠️ Startfehler: ${e?.message || e}`);
    });
  })
  .catch(e => console.error("Bot launch error:", e?.message || e));
