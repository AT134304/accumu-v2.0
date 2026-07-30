// Accumu v2 — 가상 이메일 변환 규칙 (ADR 0002 "가상 이메일 변환 규칙")
//
// buildVirtualEmail(code) = code.trim().toLowerCase() + '@accumu.local'
//
// 이 파일이 단일 소스(single source of truth)다. scripts/seed-accounts.mjs는
// 프런트엔드 프로젝트가 스캐폴딩되기 전에 작성되어 동일 로직을 로컬 복제해두었는데,
// 이제 이 파일이 존재하므로 필요 시
//   import { buildVirtualEmail } from '../src/lib/virtualEmail.js'
// 로 교체해 이중 구현을 없앨 수 있다 (seed-accounts.mjs는 1회성 스크립트라 이번 작업 스코프에서
// 강제로 교체하지는 않는다).
export function buildVirtualEmail(code) {
  return `${code.trim().toLowerCase()}@accumu.local`;
}
