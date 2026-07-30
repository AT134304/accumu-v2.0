// Accumu v2 — Supabase 클라이언트 (프런트엔드 전용, anon key만 사용)
// ADR 0001 6장: service_role 키는 절대 이 파일/프런트엔드 번들에 넣지 않는다.
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Supabase 환경변수가 설정되지 않았습니다. .env.local의 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY 값을 확인해주세요.'
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
