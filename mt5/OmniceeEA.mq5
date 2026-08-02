//+------------------------------------------------------------------+
//| OmniceeEA.mq5                                                    |
//| OMNICEE AI Trading System                                        |
//| Developed by James Yelbert                                       |
//+------------------------------------------------------------------+
#property copyright "James Yelbert - OMNICEE"
#property link      "https://github.com/cee999/omnicee"
#property version   "1.10"
#property description "OMNICEE bridge: live Exness/MT5 prices + approved signal execution"

#include <Trade/Trade.mqh>

//--- inputs
input string InpServerURL   = "https://omnicee.onrender.com";
input string InpEASecret    = "17380504905193";
input int    InpPollSeconds = 5;
input int    InpBalanceSync = 60;
input int    InpPriceSync   = 1;
input int    InpSlippage    = 10;
input int    InpMagicNumber = 777888;
input bool   InpShowAlerts  = true;

//--- globals
CTrade   trade;
datetime lastPollTime     = 0;
datetime lastBalanceSync  = 0;
datetime lastPriceSync    = 0;
datetime lastPriceLog     = 0;
int      pollIntervalSec  = 5;
int      balanceSyncSec   = 60;
int      priceSyncIntervalSec = 1;

string OmniceeSymbols[] = {"BTCUSDT","ETHUSDT","EURUSD","GBPUSD","USDJPY","XAUUSD","USOIL","UUP"};

//+------------------------------------------------------------------+
string MapSymbol(string omniceeSymbol)
{
   if(omniceeSymbol == "BTCUSDT") return "BTCUSDm";
   if(omniceeSymbol == "ETHUSDT") return "ETHUSDm";
   if(omniceeSymbol == "EURUSD")  return "EURUSDm";
   if(omniceeSymbol == "GBPUSD")  return "GBPUSDm";
   if(omniceeSymbol == "USDJPY")  return "USDJPYm";
   if(omniceeSymbol == "XAUUSD")  return "XAUUSDm";
   if(omniceeSymbol == "USOIL")   return "USOILm";
   if(omniceeSymbol == "UUP")     return "USDXm";
   return omniceeSymbol;
}

//+------------------------------------------------------------------+
void SyncBalance()
{
   string url = InpServerURL + "/api/ea/balance";
   string headers = "Content-Type: application/json\r\n";
   if(InpEASecret != "")
      headers += "X-EA-Secret: " + InpEASecret + "\r\n";

   double balance    = AccountInfoDouble(ACCOUNT_BALANCE);
   double equity     = AccountInfoDouble(ACCOUNT_EQUITY);
   double margin     = AccountInfoDouble(ACCOUNT_MARGIN);
   double freeMargin = AccountInfoDouble(ACCOUNT_MARGIN_FREE);

   string body = "{"
      + "\"balance\":"    + DoubleToString(balance, 2)    + ","
      + "\"equity\":"     + DoubleToString(equity, 2)     + ","
      + "\"margin\":"     + DoubleToString(margin, 2)     + ","
      + "\"freeMargin\":" + DoubleToString(freeMargin, 2)
      + "}";

   char postData[];
   StringToCharArray(body, postData, 0, WHOLE_ARRAY, CP_UTF8);
   ArrayResize(postData, ArraySize(postData) - 1);

   char result[];
   string resultHeaders;
   int res = WebRequest("POST", url, headers, 5000, postData, result, resultHeaders);

   if(res == 200)
      Print("[OMNICEE] Balance synced: $", DoubleToString(balance, 2));
   else if(res == -1)
      Print("[OMNICEE] Balance sync failed - add URL to allowed list");
   else
      Print("[OMNICEE] Balance sync HTTP ", res);
}

//+------------------------------------------------------------------+
void SendPriceTicks()
{
   string body = "{\"prices\":[";
   int sent = 0;

   for(int i = 0; i < ArraySize(OmniceeSymbols); i++)
   {
      string omniceeSymbol = OmniceeSymbols[i];
      string mt5Symbol     = MapSymbol(omniceeSymbol);

      if(!SymbolSelect(mt5Symbol, true))
      {
         // try without suffix
         mt5Symbol = omniceeSymbol;
         if(!SymbolSelect(mt5Symbol, true))
            continue;
      }

      double bid = SymbolInfoDouble(mt5Symbol, SYMBOL_BID);
      double ask = SymbolInfoDouble(mt5Symbol, SYMBOL_ASK);
      if(bid <= 0.0) continue;

      if(sent > 0) body += ",";
      body += "{\"symbol\":\"" + omniceeSymbol
         + "\",\"bid\":" + DoubleToString(bid, 5)
         + ",\"ask\":" + DoubleToString(ask, 5)
         + ",\"timestamp\":" + IntegerToString((long)TimeGMT() * 1000)
         + "}";
      sent++;
   }

   body += "]}";
   if(sent == 0) return;

   string url = InpServerURL + "/api/ea/prices";
   string headers = "Content-Type: application/json\r\n";
   if(InpEASecret != "")
      headers += "X-EA-Secret: " + InpEASecret + "\r\n";

   char postData[];
   StringToCharArray(body, postData, 0, WHOLE_ARRAY, CP_UTF8);
   ArrayResize(postData, ArraySize(postData) - 1);

   char result[];
   string resultHeaders;
   int res = WebRequest("POST", url, headers, 5000, postData, result, resultHeaders);

   if(res == -1)
      Print("[OMNICEE] Price sync failed - add URL to Tools -> Options -> Expert Advisors allowed list");
   else if(res != 200)
      Print("[OMNICEE] Price sync HTTP ", res, " (sent ", sent, " symbols)");
   else if(TimeCurrent() - lastPriceLog >= 30)
   {
      lastPriceLog = TimeCurrent();
      Print("[OMNICEE] Broker prices OK - ", sent, " symbols pushed");
   }
}

//+------------------------------------------------------------------+
string ExtractJsonString(string json, string key, int startPos)
{
   string search = "\"" + key + "\":\"";
   int pos = StringFind(json, search, startPos);
   if(pos < 0) return "";
   int valStart = pos + StringLen(search);
   int valEnd   = StringFind(json, "\"", valStart);
   if(valEnd < 0) return "";
   return StringSubstr(json, valStart, valEnd - valStart);
}

//+------------------------------------------------------------------+
double ExtractJsonNumber(string json, string key, int startPos)
{
   string search = "\"" + key + "\":";
   int pos = StringFind(json, search, startPos);
   if(pos < 0)
   {
      search = "\"" + key + "\": ";
      pos = StringFind(json, search, startPos);
      if(pos < 0) return 0;
   }
   int valStart = pos + StringLen(search);
   while(valStart < StringLen(json) && (StringGetCharacter(json, valStart) == ' ' || StringGetCharacter(json, valStart) == '\t'))
      valStart++;
   int valEnd = valStart;
   while(valEnd < StringLen(json))
   {
      ushort ch = StringGetCharacter(json, valEnd);
      if((ch < '0' || ch > '9') && ch != '.' && ch != '-' && ch != '+')
         break;
      valEnd++;
   }
   if(valEnd <= valStart) return 0;
   return StringToDouble(StringSubstr(json, valStart, valEnd - valStart));
}

//+------------------------------------------------------------------+
bool PlaceTrade(string symbol, string action, double sl, double tp)
{
   string mt5Symbol = MapSymbol(symbol);
   if(!SymbolSelect(mt5Symbol, true))
   {
      mt5Symbol = symbol;
      if(!SymbolSelect(mt5Symbol, true))
      {
         Print("[OMNICEE] Symbol not available: ", symbol);
         return false;
      }
   }

   double ask = SymbolInfoDouble(mt5Symbol, SYMBOL_ASK);
   double bid = SymbolInfoDouble(mt5Symbol, SYMBOL_BID);
   double tickSize  = SymbolInfoDouble(mt5Symbol, SYMBOL_TRADE_TICK_SIZE);
   double tickValue = SymbolInfoDouble(mt5Symbol, SYMBOL_TRADE_TICK_VALUE);
   double minLot    = SymbolInfoDouble(mt5Symbol, SYMBOL_VOLUME_MIN);
   double maxLot    = SymbolInfoDouble(mt5Symbol, SYMBOL_VOLUME_MAX);
   double lotStep   = SymbolInfoDouble(mt5Symbol, SYMBOL_VOLUME_STEP);
   double balance   = AccountInfoDouble(ACCOUNT_BALANCE);
   double riskUSD   = balance * 0.01;

   if(sl <= 0.0)
   {
      Print("[OMNICEE] Refusing trade - stop loss missing for ", symbol);
      return false;
   }
   if(tp <= 0.0)
   {
      Print("[OMNICEE] Refusing trade - take profit missing for ", symbol);
      return false;
   }

   double entryPrice = (action == "LONG") ? ask : bid;
   double slDistance = MathAbs(entryPrice - sl);
   if(slDistance <= 0.0 || tickValue <= 0.0 || tickSize <= 0.0)
   {
      Print("[OMNICEE] Invalid SL distance or tick info for ", symbol);
      return false;
   }
   if((action == "LONG" && sl >= entryPrice) || (action == "SHORT" && sl <= entryPrice))
   {
      Print("[OMNICEE] Refusing trade - SL on wrong side for ", action, " ", symbol);
      return false;
   }

   double slTicks = slDistance / tickSize;
   double lotSize = riskUSD / (slTicks * tickValue);
   lotSize = MathFloor(lotSize / lotStep) * lotStep;
   lotSize = MathMax(lotSize, minLot);
   lotSize = MathMin(lotSize, maxLot);
   lotSize = NormalizeDouble(lotSize, 2);

   Print("[OMNICEE] ", action, " ", mt5Symbol, " lot=", lotSize, " entry=", entryPrice, " sl=", sl, " tp=", tp);

   bool ok = false;
   if(action == "LONG")
      ok = trade.Buy(lotSize, mt5Symbol, ask, sl, tp, "OMNICEE Signal");
   else if(action == "SHORT")
      ok = trade.Sell(lotSize, mt5Symbol, bid, sl, tp, "OMNICEE Signal");

   if(!ok)
   {
      Print("[OMNICEE] Trade failed: ", trade.ResultRetcodeDescription());
      return false;
   }
   Print("[OMNICEE] Trade placed ticket=", trade.ResultOrder());
   if(InpShowAlerts)
      Alert("OMNICEE ", action, " ", mt5Symbol);
   return true;
}

//+------------------------------------------------------------------+
void PollApprovedSignals()
{
   string url = InpServerURL + "/api/ea/signals";
   if(InpEASecret != "")
      url += "?secret=" + InpEASecret;

   string headers = "Content-Type: application/json\r\n";
   if(InpEASecret != "")
      headers += "X-EA-Secret: " + InpEASecret + "\r\n";

   char postData[];
   char result[];
   string resultHeaders;
   int res = WebRequest("GET", url, headers, 5000, postData, result, resultHeaders);

   if(res != 200)
   {
      if(res == -1)
         Print("[OMNICEE] WebRequest failed. Add ", InpServerURL, " to allowed URLs");
      else
         Print("[OMNICEE] API error, HTTP ", res);
      return;
   }

   string json = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
   if(StringFind(json, "\"signals\"") < 0) return;

   // simple scan for signal objects
   int pos = 0;
   while(true)
   {
      int obj = StringFind(json, "\"symbol\"", pos);
      if(obj < 0) break;
      string symbol = ExtractJsonString(json, "symbol", obj);
      string action = ExtractJsonString(json, "action", obj);
      if(action == "")
         action = ExtractJsonString(json, "direction", obj);
      if(action == "BUY")  action = "LONG";
      if(action == "SELL") action = "SHORT";

      double sl = ExtractJsonNumber(json, "stopLoss", obj);
      if(sl <= 0.0) sl = ExtractJsonNumber(json, "sl", obj);
      double tp = ExtractJsonNumber(json, "takeProfit", obj);
      if(tp <= 0.0) tp = ExtractJsonNumber(json, "tp", obj);
      if(tp <= 0.0) tp = ExtractJsonNumber(json, "tp1", obj);

      if(symbol != "" && (action == "LONG" || action == "SHORT") && sl > 0.0 && tp > 0.0)
         PlaceTrade(symbol, action, sl, tp);

      pos = obj + 8;
   }
}

//+------------------------------------------------------------------+
int OnInit()
{
   trade.SetExpertMagicNumber(InpMagicNumber);
   trade.SetDeviationInPoints(InpSlippage);
   trade.SetTypeFilling(ORDER_FILLING_IOC);

   pollIntervalSec        = MathMax(InpPollSeconds, 3);
   balanceSyncSec         = MathMax(InpBalanceSync, 30);
   priceSyncIntervalSec   = MathMax(InpPriceSync, 1);

   Print("=== OMNICEE EA Initialized ===");
   Print("Server: ", InpServerURL);
   Print("Poll: ", pollIntervalSec, "s | Balance: ", balanceSyncSec, "s | Price: ", priceSyncIntervalSec, "s");
   Print("Symbols: ", ArraySize(OmniceeSymbols), " | Magic: ", InpMagicNumber);

   EventSetTimer(1);
   SyncBalance();
   SendPriceTicks();
   return INIT_SUCCEEDED;
}

//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   EventKillTimer();
   Print("=== OMNICEE EA Stopped ===");
}

//+------------------------------------------------------------------+
void OnTimer()
{
   datetime now = TimeCurrent();

   if(now - lastPollTime >= pollIntervalSec)
   {
      lastPollTime = now;
      PollApprovedSignals();
   }
   if(now - lastBalanceSync >= balanceSyncSec)
   {
      lastBalanceSync = now;
      SyncBalance();
   }
   if(now - lastPriceSync >= priceSyncIntervalSec)
   {
      lastPriceSync = now;
      SendPriceTicks();
   }
}

//+------------------------------------------------------------------+
void OnTick()
{
   if(TimeCurrent() - lastPriceSync >= priceSyncIntervalSec)
   {
      lastPriceSync = TimeCurrent();
      SendPriceTicks();
   }
}
//+------------------------------------------------------------------+
