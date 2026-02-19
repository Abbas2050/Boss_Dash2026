import {
  HubConnection,
  HubConnectionBuilder,
  HubConnectionState,
  IHttpConnectionOptions,
  LogLevel,
} from "@microsoft/signalr";

export type SignalRStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting";

export interface SignalRManagerOptions {
  hubUrl: string;
  reconnectDelaysMs?: number[];
  accessTokenFactory?: IHttpConnectionOptions["accessTokenFactory"];
  logLevel?: LogLevel;
  trackedEvents?: string[];
}

type EventHandler = (payload: unknown, eventName: string) => void;
type StatusHandler = (status: SignalRStatus) => void;
type ErrorHandler = (error: string) => void;

export class SignalRConnectionManager {
  private connection: HubConnection | null = null;
  private readonly options: SignalRManagerOptions;
  private readonly trackedEvents: Set<string>;
  private readonly eventHandlers = new Set<EventHandler>();
  private readonly statusHandlers = new Set<StatusHandler>();
  private readonly errorHandlers = new Set<ErrorHandler>();
  private status: SignalRStatus = "disconnected";

  constructor(options: SignalRManagerOptions) {
    this.options = options;
    this.trackedEvents = new Set(options.trackedEvents || []);
  }

  public getStatus(): SignalRStatus {
    return this.status;
  }

  public onEvent(handler: EventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  public onStatusChange(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    handler(this.status);
    return () => this.statusHandlers.delete(handler);
  }

  public onError(handler: ErrorHandler): () => void {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  public addTrackedEvent(eventName: string): void {
    this.trackedEvents.add(eventName);
    if (this.connection) this.wireEvent(eventName);
  }

  public async connect(): Promise<void> {
    if (this.connection?.state === HubConnectionState.Connected) return;
    if (this.connection?.state === HubConnectionState.Connecting) return;

    if (!this.connection) {
      this.connection = this.createConnection();
      this.wireLifecycle();
      this.wireTrackedEvents();
    }

    this.setStatus("connecting");

    try {
      await this.connection.start();
      this.setStatus("connected");
    } catch (error) {
      this.emitError(error);
      this.setStatus("disconnected");
      throw error;
    }
  }

  public async disconnect(): Promise<void> {
    if (!this.connection) return;
    await this.connection.stop();
    this.setStatus("disconnected");
  }

  private createConnection(): HubConnection {
    return new HubConnectionBuilder()
      .withUrl(this.options.hubUrl, {
        accessTokenFactory: this.options.accessTokenFactory,
      })
      .withAutomaticReconnect(this.options.reconnectDelaysMs || [0, 2000, 5000, 10000])
      .configureLogging(this.options.logLevel ?? LogLevel.Warning)
      .build();
  }

  private wireLifecycle(): void {
    if (!this.connection) return;

    this.connection.onreconnecting((error) => {
      this.setStatus("reconnecting");
      if (error) this.emitError(error);
    });

    this.connection.onreconnected(() => {
      this.setStatus("connected");
    });

    this.connection.onclose((error) => {
      this.setStatus("disconnected");
      if (error) this.emitError(error);
    });
  }

  private wireTrackedEvents(): void {
    for (const eventName of this.trackedEvents) {
      this.wireEvent(eventName);
    }
  }

  private wireEvent(eventName: string): void {
    if (!this.connection) return;

    this.connection.off(eventName);
    this.connection.on(eventName, (payload: unknown) => {
      for (const handler of this.eventHandlers) {
        handler(payload, eventName);
      }
    });
  }

  private setStatus(status: SignalRStatus): void {
    this.status = status;
    for (const handler of this.statusHandlers) {
      handler(status);
    }
  }

  private emitError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    for (const handler of this.errorHandlers) {
      handler(message);
    }
  }
}
