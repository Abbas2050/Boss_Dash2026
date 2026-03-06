import { useEffect, useState } from "react";

export interface LPAccount {
  id: number;
  name: string;
  login: string;
  password: string;
  server: string;
  status: "connected" | "disconnected";
}

export interface LPAccountRequest {
  name: string;
  login: string;
  password: string;
  server: string;
}

export async function fetchLPAccounts(): Promise<LPAccount[]> {
  // TODO: Replace with real API endpoint
  const baseUrl = "/rest/lp-accounts";
  const url = `${baseUrl}?version=${import.meta.env.VITE_API_VERSION}`;
  const token = import.meta.env.VITE_API_TOKEN;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      "Accept": "application/json",
      "Authorization": `Bearer ${token}`,
    },
  });
  if (!res.ok) throw new Error(`LP Accounts API error ${res.status}`);
  return res.json();
}

export async function createLPAccount(body: LPAccountRequest): Promise<LPAccount> {
  // TODO: Replace with real API endpoint
  const baseUrl = "/rest/lp-accounts";
  const url = `${baseUrl}?version=${import.meta.env.VITE_API_VERSION}`;
  const token = import.meta.env.VITE_API_TOKEN;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Create LP Account error ${res.status}`);
  return res.json();
}
