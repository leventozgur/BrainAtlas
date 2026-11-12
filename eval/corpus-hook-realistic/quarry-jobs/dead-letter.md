---
title: "Ölü harf kuyruğu"
status: "active"
generated: "2026-10-20"
---
# Ölü harf kuyruğu (DLQ)

## Düşme koşulu

Bir iş 5 denemenin ardından başarısız olursa DLQ'ya taşınır.

## Yeniden oynatma

quarry dlq replay komutu, verilen iş kimliğini yeniden kuyruğa alır. Toplu yeniden oynatma için since parametresi kullanılır.

## Şema uyuşmazlığı

Yük şeması uyuşmuyorsa iş yeniden oynatılmadan önce düzeltilmelidir; aksi halde aynı hata tekrarlanır.
