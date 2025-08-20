import { EventDto } from '@api/integrations/event/event.dto';
import { PrismaRepository } from '@api/repository/repository.service';
import { WAMonitoringService } from '@api/services/monitor.service';
import { wa } from '@api/types/wa.types';
import { configService, Log, Webhook } from '@config/env.config';
import { Logger } from '@config/logger.config';
// import { BadRequestException } from '@exceptions';
import axios, { AxiosInstance } from 'axios';
import * as jwt from 'jsonwebtoken';

import { EmitData, EventController, EventControllerInterface } from '../event.controller';

export class WebhookController extends EventController implements EventControllerInterface {
  private readonly logger = new Logger('WebhookController');
  
  // Buffer for messages by instanceName, event, and remoteJid
  private messageBuffer: Map<string, {
    messages: any[];
    timer: ReturnType<typeof setTimeout> | null;
    baseURL: string;
    headers?: Record<string, string>;
    origin: string;
    serverUrl: string;
  }> = new Map();
  
  // Default buffer settings
  private readonly defaultBufferTimeout = 3000; // 3 seconds
  private readonly defaultMaxBufferSize = 10; // 10 messages

  constructor(prismaRepository: PrismaRepository, waMonitor: WAMonitoringService) {
    super(prismaRepository, waMonitor, true, 'webhook');
  }
  
  /**
   * Flush all message buffers
   */
  private async flushAllBuffers(): Promise<void> {
    this.logger.log({
      local: 'WebhookController.flushAllBuffers',
      message: `Flushing all message buffers (${this.messageBuffer.size} buffers)`,
    });
    
    for (const bufferKey of this.messageBuffer.keys()) {
      try {
        await this.flushBuffer(bufferKey);
      } catch (error) {
        this.logger.error({
          local: 'WebhookController.flushAllBuffers',
          message: `Error flushing buffer ${bufferKey}: ${error?.message}`,
        });
      }
    }
  }

  override async set(instanceName: string, data: EventDto): Promise<wa.LocalWebHook> {
    // if (!/^(https?:\/\/)/.test(data.webhook.url)) {
    //   throw new BadRequestException('Invalid "url" property');
    // }

    if (!data.webhook?.enabled) {
      data.webhook.events = [];
    } else {
      if (0 === data.webhook.events.length) {
        data.webhook.events = EventController.events;
      }
    }

    // Prepare buffer settings from data or use defaults
    const bufferSettings = {
      enabled: data.webhook?.buffer?.enabled ?? false,
      timeout: data.webhook?.buffer?.timeout ?? this.defaultBufferTimeout,
      maxSize: data.webhook?.buffer?.maxSize ?? this.defaultMaxBufferSize,
    };

    return this.prisma.webhook.upsert({
      where: {
        instanceId: this.monitor.waInstances[instanceName].instanceId,
      },
      update: {
        enabled: data.webhook?.enabled,
        events: data.webhook?.events,
        url: data.webhook?.url,
        headers: data.webhook?.headers,
        webhookBase64: data.webhook.base64,
        webhookByEvents: data.webhook.byEvents,
        // Store buffer settings as JSON in webhook_buffer column
        webhook_buffer: bufferSettings,
      },
      create: {
        enabled: data.webhook?.enabled,
        events: data.webhook?.events,
        instanceId: this.monitor.waInstances[instanceName].instanceId,
        url: data.webhook?.url,
        headers: data.webhook?.headers,
        webhookBase64: data.webhook.base64,
        webhookByEvents: data.webhook.byEvents,
        // Store buffer settings as JSON in webhook_buffer column
        webhook_buffer: bufferSettings,
      },
    });
  }

  public async emit({
    instanceName,
    origin,
    event,
    data,
    serverUrl,
    dateTime,
    sender,
    apiKey,
    local,
    integration,
  }: EmitData): Promise<void> {
    if (integration && !integration.includes('webhook')) {
      return;
    }

    const instance = (await this.get(instanceName)) as wa.LocalWebHook;

    const webhookConfig = configService.get<Webhook>('WEBHOOK');
    const webhookLocal = instance?.events;
    const webhookHeaders = { ...((instance?.headers as Record<string, string>) || {}) };

    if (webhookHeaders && 'jwt_key' in webhookHeaders) {
      const jwtKey = webhookHeaders['jwt_key'];
      const jwtToken = this.generateJwtToken(jwtKey);
      webhookHeaders['Authorization'] = `Bearer ${jwtToken}`;

      delete webhookHeaders['jwt_key'];
    }

    const we = event.replace(/[.-]/gm, '_').toUpperCase();
    const transformedWe = we.replace(/_/gm, '-').toLowerCase();
    const enabledLog = configService.get<Log>('LOG').LEVEL.includes('WEBHOOKS');
    const regex = /^(https?:\/\/)/;

    // Get buffer settings from instance configuration or use defaults
    const bufferEnabled = instance?.webhook_buffer?.enabled ?? false;
    const bufferTimeout = instance?.webhook_buffer?.timeout ?? this.defaultBufferTimeout;
    const maxBufferSize = instance?.webhook_buffer?.maxSize ?? this.defaultMaxBufferSize;

    // Check if the event should be buffered (exclude non-message events and status events)
    const shouldBuffer = bufferEnabled && 
      ['MESSAGES_UPSERT', 'SEND_MESSAGE', 'MESSAGES_UPDATE'].includes(we) &&
      data && typeof data === 'object';

    const webhookData = {
      event,
      instance: instanceName,
      data,
      destination: instance?.url || `${webhookConfig.GLOBAL.URL}/${transformedWe}`,
      date_time: dateTime,
      sender,
      server_url: serverUrl,
      apikey: apiKey,
    };

    if (local && instance?.enabled) {
      if (Array.isArray(webhookLocal) && webhookLocal.includes(we)) {
        let baseURL: string;

        if (instance?.webhookByEvents) {
          baseURL = `${instance?.url}/${transformedWe}`;
        } else {
          baseURL = instance?.url;
        }

        if (enabledLog) {
          const logData = {
            local: `${origin}.sendData-Webhook`,
            url: baseURL,
            buffered: shouldBuffer,
            ...webhookData,
          };

          this.logger.log(logData);
        }

        try {
          if (instance?.enabled && regex.test(instance.url)) {
            // If buffering is enabled for this event, add it to the buffer
            if (shouldBuffer) {
              this.bufferMessage(
                instanceName, 
                event,
                data, 
                baseURL, 
                webhookHeaders, 
                origin, 
                serverUrl, 
                bufferTimeout, 
                maxBufferSize
              );
            } else {
              // For non-buffered events, send immediately
              const httpService = axios.create({
                baseURL,
                headers: webhookHeaders as Record<string, string> | undefined,
                timeout: webhookConfig.REQUEST?.TIMEOUT_MS ?? 30000,
              });

              await this.retryWebhookRequest(httpService, webhookData, `${origin}.sendData-Webhook`, baseURL, serverUrl);
            }
          }
        } catch (error) {
          this.logger.error({
            local: `${origin}.sendData-Webhook`,
            message: `Todas as tentativas falharam: ${error?.message}`,
            hostName: error?.hostname,
            syscall: error?.syscall,
            code: error?.code,
            error: error?.errno,
            stack: error?.stack,
            name: error?.name,
            url: baseURL,
            server_url: serverUrl,
          });
        }
      }
    }

    if (webhookConfig.GLOBAL?.ENABLED) {
      if (webhookConfig.EVENTS[we]) {
        let globalURL = webhookConfig.GLOBAL.URL;

        if (webhookConfig.GLOBAL.WEBHOOK_BY_EVENTS) {
          globalURL = `${globalURL}/${transformedWe}`;
        }

        if (enabledLog) {
          const logData = {
            local: `${origin}.sendData-Webhook-Global`,
            url: globalURL,
            ...webhookData,
          };

          this.logger.log(logData);
        }

        try {
          if (regex.test(globalURL)) {
            // Global webhooks are always sent immediately (no buffering)
            const httpService = axios.create({
              baseURL: globalURL,
              timeout: webhookConfig.REQUEST?.TIMEOUT_MS ?? 30000,
            });

            await this.retryWebhookRequest(
              httpService,
              webhookData,
              `${origin}.sendData-Webhook-Global`,
              globalURL,
              serverUrl,
            );
          }
        } catch (error) {
          this.logger.error({
            local: `${origin}.sendData-Webhook-Global`,
            message: `Todas as tentativas falharam: ${error?.message}`,
            hostName: error?.hostname,
            syscall: error?.syscall,
            code: error?.code,
            error: error?.errno,
            stack: error?.stack,
            name: error?.name,
            url: globalURL,
            server_url: serverUrl,
          });
        }
      }
    }
  }

  private async retryWebhookRequest(
    httpService: AxiosInstance,
    webhookData: any,
    origin: string,
    baseURL: string,
    serverUrl: string,
    maxRetries?: number,
    delaySeconds?: number,
  ): Promise<void> {
    const webhookConfig = configService.get<Webhook>('WEBHOOK');
    const maxRetryAttempts = maxRetries ?? webhookConfig.RETRY?.MAX_ATTEMPTS ?? 10;
    const initialDelay = delaySeconds ?? webhookConfig.RETRY?.INITIAL_DELAY_SECONDS ?? 5;
    const useExponentialBackoff = webhookConfig.RETRY?.USE_EXPONENTIAL_BACKOFF ?? true;
    const maxDelay = webhookConfig.RETRY?.MAX_DELAY_SECONDS ?? 300;
    const jitterFactor = webhookConfig.RETRY?.JITTER_FACTOR ?? 0.2;
    const nonRetryableStatusCodes = webhookConfig.RETRY?.NON_RETRYABLE_STATUS_CODES ?? [400, 401, 403, 404, 422];

    let attempts = 0;

    while (attempts < maxRetryAttempts) {
      try {
        await httpService.post('', webhookData);
        if (attempts > 0) {
          this.logger.log({
            local: `${origin}`,
            message: `Sucesso no envio após ${attempts + 1} tentativas`,
            url: baseURL,
          });
        }
        return;
      } catch (error) {
        attempts++;

        const isTimeout = error.code === 'ECONNABORTED';

        if (error?.response?.status && nonRetryableStatusCodes.includes(error.response.status)) {
          this.logger.error({
            local: `${origin}`,
            message: `Erro não recuperável (${error.response.status}): ${error?.message}. Cancelando retentativas.`,
            statusCode: error?.response?.status,
            url: baseURL,
            server_url: serverUrl,
          });
          throw error;
        }

        this.logger.error({
          local: `${origin}`,
          message: `Tentativa ${attempts}/${maxRetryAttempts} falhou: ${isTimeout ? 'Timeout da requisição' : error?.message}`,
          hostName: error?.hostname,
          syscall: error?.syscall,
          code: error?.code,
          isTimeout,
          statusCode: error?.response?.status,
          error: error?.errno,
          stack: error?.stack,
          name: error?.name,
          url: baseURL,
          server_url: serverUrl,
        });

        if (attempts === maxRetryAttempts) {
          throw error;
        }

        let nextDelay = initialDelay;
        if (useExponentialBackoff) {
          nextDelay = Math.min(initialDelay * Math.pow(2, attempts - 1), maxDelay);

          const jitter = nextDelay * jitterFactor * (Math.random() * 2 - 1);
          nextDelay = Math.max(initialDelay, nextDelay + jitter);
        }

        this.logger.log({
          local: `${origin}`,
          message: `Aguardando ${nextDelay.toFixed(1)} segundos antes da próxima tentativa`,
          url: baseURL,
        });

        await new Promise((resolve) => setTimeout(resolve, nextDelay * 1000));
      }
    }
  }

  private generateJwtToken(authToken: string): string {
    try {
      const payload = {
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 600, // 10 min expiration
        app: 'evolution',
        action: 'webhook',
      };

      const token = jwt.sign(payload, authToken, { algorithm: 'HS256' });
      return token;
    } catch (error) {
      this.logger.error({
        local: 'WebhookController.generateJwtToken',
        message: `JWT generation failed: ${error?.message}`,
      });
      throw error;
    }
  }

  /**
   * Add a message to the buffer for a specific instance, event, and remote jid
   */
  private bufferMessage(
    instanceName: string,
    event: string,
    data: any,
    baseURL: string,
    headers: Record<string, string> | undefined,
    origin: string,
    serverUrl: string,
    bufferTimeout: number,
    maxBufferSize: number,
  ): void {
    // Generate a unique key for this instance+event combination
    // For events with remoteJid, include that to separate by chat
    const remoteJid = data.key?.remoteJid || data.remoteJid || 'global';
    const bufferKey = `${instanceName}:${event}:${remoteJid}`;
    
    // Check if we already have a buffer for this key
    if (!this.messageBuffer.has(bufferKey)) {
      // Create a new buffer
      this.messageBuffer.set(bufferKey, {
        messages: [],
        timer: null,
        baseURL,
        headers,
        origin,
        serverUrl,
      });
    }
    
    // Get the buffer
    const buffer = this.messageBuffer.get(bufferKey);
    
    // Add the message
    buffer.messages.push(data);
    
    // If this is the first message, start the timer
    if (buffer.timer === null) {
      buffer.timer = setTimeout(() => {
        this.flushBuffer(bufferKey);
      }, bufferTimeout);
    }
    
    // If we've reached the maximum buffer size, flush immediately
    if (buffer.messages.length >= maxBufferSize) {
      if (buffer.timer) {
        clearTimeout(buffer.timer);
        buffer.timer = null;
      }
      this.flushBuffer(bufferKey);
    }
  }
  
  /**
   * Flush the buffer for a specific key
   */
  private async flushBuffer(bufferKey: string): Promise<void> {
    // Get the buffer
    const buffer = this.messageBuffer.get(bufferKey);
    
    if (!buffer || buffer.messages.length === 0) {
      this.messageBuffer.delete(bufferKey);
      return;
    }
    
    // Clear the timer
    if (buffer.timer) {
      clearTimeout(buffer.timer);
      buffer.timer = null;
    }
    
    const { messages, baseURL, headers, origin, serverUrl } = buffer;
    
    // Create a payload with the buffered messages
    const webhookData = {
      event: bufferKey.split(':')[1],
      instance: bufferKey.split(':')[0],
      data: messages,
      count: messages.length,
      isBuffered: true,
      destination: baseURL,
      date_time: new Date().toISOString(),
      server_url: serverUrl,
    };
    
    // Remove the buffer before sending to prevent double-sending if an error occurs
    this.messageBuffer.delete(bufferKey);
    
    try {
      // Create HTTP service
      const httpService = axios.create({
        baseURL,
        headers: headers as Record<string, string> | undefined,
        timeout: configService.get<Webhook>('WEBHOOK').REQUEST?.TIMEOUT_MS ?? 30000,
      });
      
      // Send the buffered messages
      await this.retryWebhookRequest(
        httpService,
        webhookData,
        `${origin}.sendData-Webhook-Buffered`,
        baseURL,
        serverUrl
      );
      
      this.logger.log({
        local: `${origin}.sendData-Webhook-Buffered`,
        message: `Successfully sent ${messages.length} buffered messages`,
        url: baseURL,
      });
    } catch (error) {
      this.logger.error({
        local: `${origin}.sendData-Webhook-Buffered`,
        message: `Failed to send buffered messages: ${error?.message}`,
        error: error?.errno,
        url: baseURL,
        server_url: serverUrl,
      });
    }
  }
}
