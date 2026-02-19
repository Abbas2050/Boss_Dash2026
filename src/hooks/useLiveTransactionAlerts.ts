import { useEffect } from "react";
import { toast } from "@/hooks/use-toast";

// Minimal type for live transaction alert (adapt as needed)
interface LiveTransaction {
  time: string;
  transactionType: string;
  login: number;
  name: string;
  amount: number;
}

export function useLiveTransactionAlerts() {
  useEffect(() => {
    // Connect to SignalR (adapt URL as needed)
    const connection = new (window as any).signalR.HubConnectionBuilder()
      .withUrl("/ws/dashboard")
      .withAutomaticReconnect([0, 2000, 5000, 10000])
      .build();

    connection.on("TransactionAlert", (data: LiveTransaction) => {
      const sign = data.amount > 0 ? "+" : "";
      const amountClass =
        data.amount > 0 ? "credit" : data.amount < 0 ? "debit" : "neutral";

      toast({
        title: `${data.transactionType} (${amountClass})`,
        description: `${data.name || data.login} | ${sign}${data.amount.toLocaleString()} USD | ${data.time}`,
        variant: data.amount < 0 ? "destructive" : "default",
      });
    });

    connection.start().catch(() => {});
    return () => { connection.stop(); };
  }, []);
}
