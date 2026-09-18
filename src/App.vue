<script setup lang="ts">
/**
 * 整个应用只有一页：观看页。
 *
 * 刻意**不引 vue-router** —— 一个房间、一个页面，路由是纯负担。
 * 有没有令牌只看地址栏的 ?k=，判断逻辑在 WatchView 里。
 */
import WatchView from '@/views/WatchView.vue'
</script>

<template>
  <WatchView />
</template>
