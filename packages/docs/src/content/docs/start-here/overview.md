---
title: Overview
description: Junior is an extensible Slackbot runtime; this page explains the plugin-first model and how to get started fast.
type: conceptual
summary: Learn why Junior is built around easy extension with skills and plugins, and how to move from first setup to custom integrations.
prerequisites: []
related:
  - /start-here/quickstart/
  - /extend/plugins-overview/
  - /extend/custom-plugins/
  - /start-here/verify-and-troubleshoot/
  - /concepts/execution-model/
---

Junior is a Slackbot runtime for Next.js apps with one core goal: make extension easy. You can start with a working Slack thread assistant quickly, then add your own skills and provider plugins without rewriting the runtime.

## The core methodology

Junior separates runtime concerns from product-specific behavior. The runtime handles Slack ingress, queue-backed execution, and safe turn processing. Your team adds behavior through skills and plugins, so extension work stays focused on capabilities instead of infrastructure.

This is the operating model throughout the docs: wire the runtime once, then evolve behavior by adding or changing skills.

## Why this is easy to extend

Junior’s extension surface is intentionally small. Skills define what the bot can do in plain, scoped units. Plugins package provider-specific capabilities, auth wiring, and optional skill bundles. In practice, that means most changes happen at the skill/plugin layer, not in routing or queue plumbing.

You can distribute plugins as npm packages for reuse across projects, or keep them local in `app/plugins` when the integration is app-specific.

## How a request flows

When someone mentions Junior in Slack, the runtime validates and routes the event, enqueues thread work, executes the turn with allowed capabilities, and posts the result back into the same thread. This keeps webhook paths fast and makes long-running work observable and recoverable.

## What success looks like

Success is not just “the bot replied.” Success means your team can ship new behavior by adding or updating skills, keep credentials scoped through capability gates, and maintain predictable runtime behavior as integrations grow.

If extending Junior requires touching core runtime files for every new use case, your setup is off the intended path.

## Who should use Junior

Junior is a strong fit for teams that already operate in Slack threads and want a controllable way to add incident, ops, or engineering workflows over time. If your primary goal is a generic web chat interface, Junior is usually not the first tool to reach for.

## Start path

Start with [Quickstart](/start-here/quickstart/) to wire runtime and production deployment in one flow. Then move to [Plugins Overview](/extend/plugins-overview/) and [Custom Plugins](/extend/custom-plugins/) to extend Junior with your own capabilities.
