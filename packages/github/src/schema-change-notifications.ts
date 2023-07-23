import { buildSchema } from 'graphql';
import * as probot from 'probot';
import { diff } from '@graphql-inspector/core';
import {
  createConfig,
  NormalizedEnvironment,
  Notifications,
  SchemaPointer,
} from './helpers/config.js';
import { ConfigLoader, FileLoader, loadSources } from './helpers/loaders.js';
import { createLogger } from './helpers/logger.js';
import { notifyWithDiscord, notifyWithSlack, notifyWithWebhook } from './helpers/notifications.js';
import { ErrorHandler } from './helpers/types.js';

export async function handleSchemaChangeNotifications({
  context,
  ref,
  repo,
  owner,
  before,
  loadFile,
  loadConfig,
  onError,
  release,
  action,
}: {
  context: probot.Context;
  owner: string;
  repo: string;
  ref: string;
  before: string;
  loadFile: FileLoader;
  loadConfig: ConfigLoader;
  onError: ErrorHandler;
  release: string;
  action: string;
}): Promise<void> {
  const id = `${owner}/${repo}#${ref}`;
  const logger = createLogger('NOTIFICATIONS', context, release);
  const { payload } = context;

  logger.info(`started - ${id}`);
  logger.info(`action - ${action}`);

  const isBranchPush = ref.startsWith('refs/heads/');

  if (!isBranchPush) {
    logger.warn(`Received Push event is not a branch push event (ref "${ref}")`);
    return;
  }

  const rawConfig = await loadConfig();

  if (!rawConfig) {
    logger.error(`Missing config file`);
    return;
  }

  const branch = ref.replace('refs/heads/', '');
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  const config = createConfig(rawConfig as any, () => {}, [branch]);

  if (!config.notifications) {
    logger.info(`disabled. Skipping...`);
    return;
  }
  logger.info(`enabled`);

  if (config.branch !== branch) {
    logger.info(
      `Received branch "${branch}" doesn't match expected branch "${config.branch}". Skipping...`,
    );
    return;
  }

  const oldPointer: SchemaPointer = {
    path: config.schema,
    ref: before,
  };
  console.log("oldPointer", oldPointer)
  const newPointer: SchemaPointer = {
    path: config.schema,
    ref,
  };
  console.log("newPointer", newPointer)

  const sources = await loadSources({
    config,
    oldPointer,
    newPointer,
    loadFile,
  });
  console.log("sources", sources)

  const schemas = {
    old: buildSchema(sources.old, {
      assumeValid: true,
      assumeValidSDL: true,
    }),
    new: buildSchema(sources.new, {
      assumeValid: true,
      assumeValidSDL: true,
    }),
  };
  console.log("schemas", schemas)

  logger.info(`built schemas`);

  const changes = await diff(schemas.old, schemas.new);

  if (!changes.length) {
    logger.info(`schemas are equal. Skipping...`);
    return;
  }

  const notifications = config.notifications;
  async function actionRunner(target: string, fn: () => Promise<void>) {
    try {
      await fn();
    } catch (error: any) {
      onError(error);
      logger.error(`Failed to send a notification via ${target}`, error);
    }
  }

  if (hasNotificationsEnabled(notifications)) {
    const actions: Array<Promise<void>> = [];
    console.log("actions", actions)
    let commit: string | undefined;
    if ("commits" in payload) {
      commit = payload.commits[0].id as string | undefined;
    }


    if (notifications.slack) {
      actions.push(
        actionRunner('slack', () =>
          notifyWithSlack({
            url: notifications.slack!,
            changes,
            environment: config.name,
            repo,
            owner,
            commit,
          }),
        ),
      );
    }

    if (notifications.discord) {
      actions.push(
        actionRunner('discord', () =>
          notifyWithDiscord({
            url: notifications.discord!,
            changes,
            environment: config.name,
            repo,
            owner,
            commit,
          }),
        ),
      );
    }
    console.log("notifications", notifications.webhook)

    if (notifications.webhook) {
      actions.push(
        actionRunner('webhook', () =>
          notifyWithWebhook({
            url: notifications.webhook!,
            changes,
            environment: config.name,
            repo,
            owner,
            commit,
          }),
        ),
      );
    }

    if (actions.length) {
      await Promise.all(actions);
    }
  }
}

function hasNotificationsEnabled(
  notifications: NormalizedEnvironment['notifications'],
): notifications is Notifications {
  return notifications && typeof notifications === 'object';
}
