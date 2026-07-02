//+------------------------------------------------------------------+
//|                                                  OmniceeEA.mq5   |
//|                         OMNICEE AI Trading System                 |
//|                         Developed by James Yelbert                |
//+------------------------------------------------------------------+
#property copyright   "James Yelbert — OMNICEE"
#property link        "https://github.com/cee999/omnicee"
#property version     "1.00"
#property description "Connects to OMNICEE cloud. Executes APPROVED signals only."
#property strict

#include <Trade\Trade.mqh>

//+------------------------------------------------------------------+
//| Input parameters                                                  |
//+------------------------------------------------------------------+
input string   InpServerURL   = "https://omnicee.onrender.com"; // OMNICEE Server URL
input string   InpEASecret    = "";                              // EA Secret (leave blank if none)
input int      InpPollSeconds = 5;                               // Poll interval (seconds)
input int      InpBalanceSync = 60;                              // Balance sync interval (seconds)
input int      InpSlippage    = 10;                              // Max slippage (points)
input int      InpMagicNumber = 777888;                          // EA Magic Number
input bool     InpShowAlerts  = true;                            // Show alerts on execution

//+------------------------------------------------------------------+
//| Global variables                                                  |
//+------------------------------------------------------------------+
CTrade trade;
datetime lastPollTime   = 0;
datetime lastBalanceSync = 0;
int      pollIntervalSec;
int      balanceSyncSec;

//+------------------------------------------------------------------+
//| Symbol name mapping: OMNICEE symbol → MT5 broker symbol           |
//| Adjust the right side to match your Exness symbol names           |
//+------------------------------------------------------------------+
string MapSymbol(string omniceeSymbol)
{
   // Crypto
   if(omniceeSymbol == "BTCUSDT")   return "BTCUSDm";  // Exness crypto
   if(omniceeSymbol == "ETHUSDT")   return "ETHUSDm";
   
   // Forex — most brokers use standard names
   if(omniceeSymbol == "EURUSD")    return "EURUSDm";
   if(omniceeSymbol == "GBPUSD")    return "GBPUSDm";
   if(omniceeSymbol == "USDJPY")    return "USDJPYm";
   
   // Commodities
   if(omniceeSymbol == "XAUUSD")    return "XAUUSDm";
   if(omniceeSymbol == "USOIL")     return "USOILm";
   
   // Default: try the symbol as-is
   return omniceeSymbol;
}

//+------------------------------------------------------------------+
//| Expert initialization                                             |
//+------------------------------------------------------------------+
int OnInit()
{
   trade.SetExpertMagicNumber(InpMagicNumber);
   trade.SetDeviationInPoints(InpSlippage);
   trade.SetTypeFilling(ORDER_FILLING_IOC);
   
   pollIntervalSec  = MathMax(InpPollSeconds, 3);
   balanceSyncSec   = MathMax(InpBalanceSync, 30);
   
   Print("=== OMNICEE EA Initialized ===");
   Print("Server: ", InpServerURL);
   Print("Poll interval: ", pollIntervalSec, "s");
   Print("Balance sync: ", balanceSyncSec, "s");
   Print("Magic: ", InpMagicNumber);
   
   // Sync balance immediately
   SyncBalance();
   
   return INIT_SUCCEEDED;
}

//+------------------------------------------------------------------+
//| Expert deinitialization                                           |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   Print("=== OMNICEE EA Stopped ===");
}

//+------------------------------------------------------------------+
//| Expert tick function                                              |
//+------------------------------------------------------------------+
void OnTick()
{
   datetime now = TimeCurrent();
   
   // Poll for approved signals
   if(now - lastPollTime >= pollIntervalSec)
   {
      lastPollTime = now;
      PollApprovedSignals();
   }
   
   // Sync balance periodically
   if(now - lastBalanceSync >= balanceSyncSec)
   {
      lastBalanceSync = now;
      SyncBalance();
   }
}

//+------------------------------------------------------------------+
//| Poll the OMNICEE API for approved signals                        |
//+------------------------------------------------------------------+
void PollApprovedSignals()
{
   string url = InpServerURL + "/api/ea/signals";
   if(InpEASecret != "")
      url += "?secret=" + InpEASecret;
   
   string headers = "Content-Type: application/json\r\n";
   if(InpEASecret != "")
      headers += "X-EA-Secret: " + InpEASecret + "\r\n";
   
   char   postData[];
   char   result[];
   string resultHeaders;
   
   int res = WebRequest("GET", url, headers, 5000, postData, result, resultHeaders);
   
   if(res != 200)
   {
      if(res == -1)
         Print("[OMNICEE] WebRequest failed. Add ", InpServerURL, " to Tools → Options → Expert Advisors → Allowed URLs");
      else
         Print("[OMNICEE] API error, HTTP ", res);
      return;
   }
   
   string json = CharArrayToString(result);
   
   // Parse signals from JSON response
   // Expected: {"ok":true,"signals":[{...}]}
   if(StringFind(json, "\"signals\":[]") >= 0)
      return; // No pending signals
   
   // Extract each signal
   int signalStart = 0;
   while(true)
   {
      signalStart = StringFind(json, "\"id\":\"", signalStart);
      if(signalStart < 0) break;
      
      string signalId = ExtractJsonString(json, "id", signalStart);
      string symbol   = ExtractJsonString(json, "symbol", signalStart);
      string action   = ExtractJsonString(json, "action", signalStart);
      double slPrice  = ExtractNestedDouble(json, "stopLoss", "price", signalStart);
      double tp1Price = ExtractNestedDouble(json, "targets", "tp1", signalStart);
      double riskPct  = ExtractJsonDouble(json, "riskPct", signalStart);
      
      if(signalId == "" || symbol == "" || action == "")
      {
         signalStart++;
         continue;
      }
      
      // Map to broker symbol
      string brokerSymbol = MapSymbol(symbol);
      
      // Check if symbol exists on this broker
      if(!SymbolSelect(brokerSymbol, true))
      {
         Print("[OMNICEE] Symbol not available: ", brokerSymbol, " (from ", symbol, ")");
         // Try without suffix
         brokerSymbol = symbol;
         if(!SymbolSelect(brokerSymbol, true))
         {
            Print("[OMNICEE] Symbol also not available as: ", brokerSymbol);
            signalStart++;
            continue;
         }
      }
      
      // Execute the trade
      bool executed = ExecuteTrade(brokerSymbol, action, slPrice, tp1Price, riskPct);
      
      if(executed)
      {
         // Report execution back to OMNICEE
         ReportExecution(signalId, brokerSymbol, trade.ResultPrice(),
                         slPrice, tp1Price, trade.ResultVolume(), (long)trade.ResultOrder());
         
         if(InpShowAlerts)
            Alert("[OMNICEE] Trade executed: ", action, " ", brokerSymbol);
      }
      
      signalStart++;
   }
}

//+------------------------------------------------------------------+
//| Execute a trade with proper lot sizing                           |
//+------------------------------------------------------------------+
bool ExecuteTrade(string symbol, string action, double sl, double tp, double riskPct)
{
   double balance   = AccountInfoDouble(ACCOUNT_BALANCE);
   double riskUSD   = balance * (riskPct / 100.0);
   double point     = SymbolInfoDouble(symbol, SYMBOL_POINT);
   double tickValue = SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_VALUE);
   double tickSize  = SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_SIZE);
   double minLot    = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MIN);
   double maxLot    = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MAX);
   double lotStep   = SymbolInfoDouble(symbol, SYMBOL_VOLUME_STEP);
   
   double ask = SymbolInfoDouble(symbol, SYMBOL_ASK);
   double bid = SymbolInfoDouble(symbol, SYMBOL_BID);
   
   if(ask == 0 || bid == 0)
   {
      Print("[OMNICEE] Cannot get price for ", symbol);
      return false;
   }
   
   // Calculate lot size based on risk
   double entryPrice = (action == "LONG") ? ask : bid;
   double slDistance  = MathAbs(entryPrice - sl);
   
   if(slDistance <= 0 || tickValue <= 0 || tickSize <= 0)
   {
      Print("[OMNICEE] Invalid SL distance or tick info for ", symbol);
      return false;
   }
   
   double slTicks = slDistance / tickSize;
   double lotSize = riskUSD / (slTicks * tickValue);
   
   // Normalize lot size
   lotSize = MathFloor(lotSize / lotStep) * lotStep;
   lotSize = MathMax(lotSize, minLot);
   lotSize = MathMin(lotSize, maxLot);
   lotSize = NormalizeDouble(lotSize, 2);
   
   Print("[OMNICEE] ", action, " ", symbol, " | Lot: ", lotSize, 
         " | Entry: ", entryPrice, " | SL: ", sl, " | TP: ", tp,
         " | Risk: $", DoubleToString(riskUSD, 2));
   
   bool result = false;
   
   if(action == "LONG")
   {
      result = trade.Buy(lotSize, symbol, ask, sl, tp, "OMNICEE Signal");
   }
   else if(action == "SHORT")
   {
      result = trade.Sell(lotSize, symbol, bid, sl, tp, "OMNICEE Signal");
   }
   
   if(!result)
   {
      Print("[OMNICEE] Trade failed: ", trade.ResultRetcodeDescription());
      return false;
   }
   
   Print("[OMNICEE] Trade placed! Ticket: ", trade.ResultOrder());
   return true;
}

//+------------------------------------------------------------------+
//| Report trade execution back to OMNICEE server                    |
//+------------------------------------------------------------------+
void ReportExecution(string signalId, string symbol, double entryPrice,
                     double sl, double tp, double lotSize, long ticket)
{
   string url = InpServerURL + "/api/ea/executed";
   
   string headers = "Content-Type: application/json\r\n";
   if(InpEASecret != "")
      headers += "X-EA-Secret: " + InpEASecret + "\r\n";
   
   string body = "{" +
      "\"signalId\":\"" + signalId + "\"," +
      "\"lotSize\":" + DoubleToString(lotSize, 2) + "," +
      "\"entryPrice\":" + DoubleToString(entryPrice, (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS)) + "," +
      "\"sl\":" + DoubleToString(sl, (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS)) + "," +
      "\"tp\":" + DoubleToString(tp, (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS)) + "," +
      "\"ticket\":" + IntegerToString(ticket) +
   "}";
   
   char postData[];
   StringToCharArray(body, postData, 0, WHOLE_ARRAY, CP_UTF8);
   // Remove null terminator
   ArrayResize(postData, ArraySize(postData) - 1);
   
   char   result[];
   string resultHeaders;
   
   int res = WebRequest("POST", url, headers, 5000, postData, result, resultHeaders);
   
   if(res == 200)
      Print("[OMNICEE] Execution reported for signal: ", signalId);
   else
      Print("[OMNICEE] Failed to report execution, HTTP ", res);
}

//+------------------------------------------------------------------+
//| Sync account balance to OMNICEE server                           |
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
   
   string body = "{" +
      "\"balance\":"    + DoubleToString(balance, 2)    + "," +
      "\"equity\":"     + DoubleToString(equity, 2)     + "," +
      "\"margin\":"     + DoubleToString(margin, 2)     + "," +
      "\"freeMargin\":" + DoubleToString(freeMargin, 2) +
   "}";
   
   char postData[];
   StringToCharArray(body, postData, 0, WHOLE_ARRAY, CP_UTF8);
   ArrayResize(postData, ArraySize(postData) - 1);
   
   char   result[];
   string resultHeaders;
   
   int res = WebRequest("POST", url, headers, 5000, postData, result, resultHeaders);
   
   if(res == 200)
      Print("[OMNICEE] Balance synced: $", DoubleToString(balance, 2));
   else if(res == -1)
      Print("[OMNICEE] Balance sync failed — add URL to allowed list");
}

//+------------------------------------------------------------------+
//| JSON string extraction helper                                     |
//+------------------------------------------------------------------+
string ExtractJsonString(string &json, string key, int startPos)
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
//| JSON double extraction helper                                     |
//+------------------------------------------------------------------+
double ExtractJsonDouble(string &json, string key, int startPos)
{
   string search = "\"" + key + "\":";
   int pos = StringFind(json, search, startPos);
   if(pos < 0) return 0;
   
   int valStart = pos + StringLen(search);
   string rest  = StringSubstr(json, valStart, 20);
   
   // Find end of number
   string numStr = "";
   for(int i = 0; i < StringLen(rest); i++)
   {
      ushort ch = StringGetCharacter(rest, i);
      if((ch >= '0' && ch <= '9') || ch == '.' || ch == '-')
         numStr += CharToString((uchar)ch);
      else
         break;
   }
   
   if(numStr == "") return 0;
   return StringToDouble(numStr);
}

//+------------------------------------------------------------------+
//| Extract nested double like "stopLoss":{"price":1234.56}          |
//+------------------------------------------------------------------+
double ExtractNestedDouble(string &json, string outerKey, string innerKey, int startPos)
{
   string search = "\"" + outerKey + "\":{";
   int pos = StringFind(json, search, startPos);
   if(pos < 0)
   {
      // Try flat: "stopLoss":{"price":...} sometimes serialized as nested
      search = "\"" + outerKey + "\":";
      pos = StringFind(json, search, startPos);
      if(pos < 0) return 0;
   }
   
   // Find innerKey within the next 200 chars
   int searchEnd = MathMin(pos + 200, StringLen(json));
   string sub = StringSubstr(json, pos, searchEnd - pos);
   
   string innerSearch = "\"" + innerKey + "\":";
   int innerPos = StringFind(sub, innerSearch, 0);
   if(innerPos < 0)
   {
      // For targets.tp1.price — look for "price" after finding tp1
      innerSearch = "\"price\":";
      innerPos = StringFind(sub, innerSearch, 0);
      if(innerPos < 0) return 0;
   }
   
   int valStart = innerPos + StringLen(innerSearch);
   string valStr = "";
   for(int i = valStart; i < StringLen(sub); i++)
   {
      ushort ch = StringGetCharacter(sub, i);
      if((ch >= '0' && ch <= '9') || ch == '.' || ch == '-')
         valStr += CharToString((uchar)ch);
      else if(valStr != "")
         break;
   }
   
   if(valStr == "") return 0;
   return StringToDouble(valStr);
}
//+------------------------------------------------------------------+
