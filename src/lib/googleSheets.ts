// Google Sheets CSV integration

export interface SheetBalance {
  label: string;
  value: number;
  currency?: string;
}

const SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRmH7o0tjWx9MxvTDYNBNhkXA9R6h18rJFzEsKXX8oUDicl0Z6udnl4SrH-vKSOxA/pub?output=csv';

/**
 * Parse CSV text to array of rows
 */
function parseCSV(csvText: string): string[][] {
  const lines = csvText.trim().split('\n');
  return lines.map(line => {
    // Simple CSV parsing (handles basic cases)
    const values: string[] = [];
    let current = '';
    let inQuotes = false;
    
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        values.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    values.push(current.trim());
    
    return values;
  });
}

/**
 * Fetch and parse Google Sheets data
 */
export async function fetchSheetBalances(): Promise<SheetBalance[]> {
  try {
    const response = await fetch(SHEET_CSV_URL);
    
    if (!response.ok) {
      throw new Error(`Failed to fetch sheet: ${response.status}`);
    }
    
    const csvText = await response.text();

    const rows = parseCSV(csvText);
    
    // Assuming the sheet structure is:
    // Row 1: Headers (e.g., "Label", "Value", "Currency")
    // Row 2+: Data rows
    
    const balances: SheetBalance[] = [];
    
    // Skip header row (index 0), process data rows
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (row.length >= 2 && row[0] && row[1]) {
        const label = row[0];
        const valueStr = row[1].replace(/[,$]/g, ''); // Remove commas and dollar signs
        const value = parseFloat(valueStr) || 0;
        const currency = row[2] || 'USD';
        
        balances.push({
          label,
          value,
          currency,
        });
      }
    }
    
    return balances;
    
  } catch (error) {
    // Return empty array on error
    return [];
  }
}
