import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  console.error('Supabase URL en Key ontbreken. Kopieer .env.example naar .env en vul je gegevens in.')
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey)
