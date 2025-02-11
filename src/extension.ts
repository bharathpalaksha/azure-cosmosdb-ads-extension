"use strict";
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from "vscode";
import * as nls from "vscode-nls";
import * as fs from "fs";
import * as cp from "child_process";
import * as path from "path";

// The module 'azdata' contains the Azure Data Studio extensibility API
// This is a complementary set of APIs that add SQL / Data-specific functionality to the app
// Import the module and reference it with the alias azdata in your code below

import * as azdata from "azdata";
import { ConnectionProvider, MongoProviderId, NoSqlProviderId } from "./Providers/connectionProvider";
import { MongoIconProvider, NoSqlIconProvider } from "./Providers/iconProvider";
import {
  MongoObjectExplorerProvider,
  NoSqlObjectExplorerProvider,
  createNodePath,
  getNodeInfo,
} from "./Providers/objectExplorerNodeProvider";
import { AppContext, createStatusBarItem, hideStatusBarItem, showStatusBarItem } from "./appContext";
import { registerMongoHomeDashboardTabs } from "./Dashboards/homeDashboard";
import { UriHandler } from "./protocol/UriHandler";
import ViewLoader from "./QueryClient/ViewLoader";
import { downloadMongoShell } from "./MongoShell/MongoShellUtil";
import { convertToConnectionOptions, IConnectionOptions } from "./models";
import TelemetryReporter from "@microsoft/ads-extension-telemetry";
import { getErrorMessage, getPackageInfo } from "./util";
import { CdbCollectionCreateInfo } from "./sampleData/DataSamplesUtil";
import { EditorUserQuery } from "./QueryClient/messageContract";
import { askUserForConnectionProfile, isAzureAuthType } from "./Services/ServiceUtil";
import { CosmosDbMongoDatabaseDashboard } from "./Dashboards/CosmosDbMongoDatabaseDashboard";
import { NativeMongoDatabaseDashboard } from "./Dashboards/NativeMongoDatabaseDashboard";
import { ArmServiceMongo } from "./Services/ArmServiceMongo";
import { ArmServiceNoSql } from "./Services/ArmServiceNoSql";
import { CosmosDbNoSqlDatabaseDashboard } from "./Dashboards/CosmosDbNoSqlDatabaseDashboard";

const localize = nls.loadMessageBundle();
// uncomment to test
// let localize = nls.config({ locale: 'pseudo' })();

export interface HasConnectionProfile {
  connectionProfile: azdata.IConnectionProfile;
}

// Used to update the node tree
export interface IConnectionNodeInfo extends IConnectionOptions {
  connectionId: string;
  nodePath?: string;
}

export interface IDatabaseDashboardInfo extends IConnectionOptions {
  databaseName: string | undefined;
  connectionId: string;
}

let appContext: AppContext;

export function activate(context: vscode.ExtensionContext) {
  const terminalMap = new Map<string, number>(); // terminal name <-> counter

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "cosmosdb-ads-extension.createMongoDatabase",
      async (objectExplorerContext: azdata.ObjectExplorerContext, connectionNodeInfo: IConnectionNodeInfo) => {
        if (objectExplorerContext && !objectExplorerContext.connectionProfile) {
          vscode.window.showErrorMessage(localize("missingConnectionProfile", "Missing ConnectionProfile"));
          Promise.reject();
          return;
        }

        if (objectExplorerContext) {
          const connectionProfile = objectExplorerContext.connectionProfile!;
          connectionNodeInfo = {
            connectionId: connectionProfile.id,
            ...convertToConnectionOptions(connectionProfile),
            nodePath: objectExplorerContext.nodeInfo?.nodePath,
          };
        }

        if (!connectionNodeInfo) {
          const connectionProfile = await askUserForConnectionProfile();
          if (!connectionProfile) {
            vscode.window.showErrorMessage(localize("missingConnectionProfile", "Missing ConnectionProfile"));
            return;
          }

          connectionNodeInfo = {
            connectionId: connectionProfile.connectionId,
            ...convertToConnectionOptions(connectionProfile),
          };
        }

        try {
          // Creating a database requires creating a collection inside
          const { databaseName } = await appContext.mongoService.createMongoDatabase(connectionNodeInfo);
          if (databaseName) {
            vscode.window.showInformationMessage(
              localize("sucessfullyCreatedDatabase", "Successfully created database: {0}", databaseName)
            );
            mongoObjectExplorer.updateNode(connectionNodeInfo.connectionId, connectionNodeInfo.server);
            Promise.resolve();
            return;
          }
        } catch (e) {
          vscode.window.showErrorMessage(
            `${localize("failedCreatedDatabase", "Failed to create mongo database")}: ${e})`
          );
        }
        Promise.reject();
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "cosmosdb-ads-extension.createNoSqlDatabase",
      async (objectExplorerContext: azdata.ObjectExplorerContext, connectionNodeInfo: IConnectionNodeInfo) => {
        if (objectExplorerContext && !objectExplorerContext.connectionProfile) {
          vscode.window.showErrorMessage(localize("missingConnectionProfile", "Missing ConnectionProfile"));
          Promise.reject();
          return;
        }

        if (objectExplorerContext) {
          const connectionProfile = objectExplorerContext.connectionProfile!;
          connectionNodeInfo = {
            connectionId: connectionProfile.id,
            ...convertToConnectionOptions(connectionProfile),
            nodePath: objectExplorerContext.nodeInfo?.nodePath,
          };
        }

        if (!connectionNodeInfo) {
          const connectionProfile = await askUserForConnectionProfile();
          if (!connectionProfile) {
            vscode.window.showErrorMessage(localize("missingConnectionProfile", "Missing ConnectionProfile"));
            return;
          }

          connectionNodeInfo = {
            connectionId: connectionProfile.connectionId,
            ...convertToConnectionOptions(connectionProfile),
          };
        }

        try {
          // Creating a database requires creating a collection inside
          const { databaseName } = await appContext.cosmosDbNoSqlService.createNoSqlDatabase(connectionNodeInfo);
          if (databaseName) {
            vscode.window.showInformationMessage(
              localize("sucessfullyCreatedDatabase", "Successfully created database: {0}", databaseName)
            );
            noSqlObjectExplorer.updateNode(connectionNodeInfo.connectionId, connectionNodeInfo.server);
            Promise.resolve();
            return;
          }
        } catch (e) {
          vscode.window.showErrorMessage(
            `${localize("failedCreatedDatabase", "Failed to create mongo database")}: ${e})`
          );
        }
        Promise.reject();
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "cosmosdb-ads-extension.createMongoCollection",
      async (
        objectExplorerContext: azdata.ObjectExplorerContext,
        connectionNodeInfo: IConnectionNodeInfo,
        collectionName?: string,
        cdbCreateInfo?: CdbCollectionCreateInfo
      ): Promise<{ databaseName: string; collectionName: string }> => {
        if (objectExplorerContext && !objectExplorerContext.connectionProfile) {
          vscode.window.showErrorMessage(localize("missingConnectionProfile", "Missing ConnectionProfile"));
          return Promise.reject();
        }

        if (objectExplorerContext && !objectExplorerContext.nodeInfo) {
          vscode.window.showErrorMessage(localize("missingNodeInfo", "Missing node information"));
          return Promise.reject();
        }

        if (objectExplorerContext) {
          const connectionProfile = objectExplorerContext.connectionProfile!;
          connectionNodeInfo = {
            connectionId: connectionProfile.id,
            ...convertToConnectionOptions(connectionProfile),
            nodePath: objectExplorerContext.nodeInfo?.nodePath,
          };
        }

        if (!connectionNodeInfo) {
          const connectionProfile = await askUserForConnectionProfile();
          if (!connectionProfile) {
            vscode.window.showErrorMessage(localize("missingConnectionProfile", "Missing ConnectionProfile"));
            return Promise.reject();
          }

          connectionNodeInfo = {
            connectionId: connectionProfile.connectionId,
            ...convertToConnectionOptions(connectionProfile),
            nodePath: createNodePath(connectionProfile.serverName),
          };
        }

        const { databaseName } = getNodeInfo(connectionNodeInfo.nodePath!);

        try {
          const createResult = await appContext.mongoService.createMongoDatabaseAndCollection(
            connectionNodeInfo,
            databaseName,
            collectionName,
            cdbCreateInfo
          );
          if (createResult.collectionName) {
            vscode.window.showInformationMessage(
              localize("successCreateCollection", "Successfully created: {0}", createResult.collectionName)
            );
            mongoObjectExplorer.updateNode(connectionNodeInfo.connectionId, connectionNodeInfo.nodePath);
            return Promise.resolve({ ...createResult, collectionName: createResult.collectionName! });
          }
        } catch (e) {
          vscode.window.showErrorMessage(`${localize("failedCreateCollection", "Failed to create collection")}: ${e}`);
          return Promise.reject();
        }
        vscode.window.showErrorMessage(localize("failedCreateCollection", "Failed to create collection"));
        return Promise.reject();
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "cosmosdb-ads-extension.deleteMongoDatabase",
      async (objectExplorerContext: azdata.ObjectExplorerContext) => {
        if (!objectExplorerContext.connectionProfile) {
          vscode.window.showErrorMessage(localize("missingConnectionProfile", "Missing ConnectionProfile"));
          return;
        }

        const { serverName } = objectExplorerContext.connectionProfile;
        if (!objectExplorerContext.nodeInfo) {
          vscode.window.showErrorMessage(localize("missingNodeInfo", "Missing node information"));
          return;
        }
        const { nodePath } = objectExplorerContext.nodeInfo;
        const mongoInfo = getNodeInfo(nodePath);

        const response = await vscode.window.showInputBox({
          placeHolder: localize("removeDatabaseConfirm", "Please enter the name of the database to delete"),
        });

        if (response !== mongoInfo.databaseName) {
          vscode.window.showErrorMessage(
            localize(
              "incorrectDeleteDatabase",
              "Incorrect name supplied to delete database {0}",
              mongoInfo.databaseName
            )
          );
          return;
        }

        try {
          if (await appContext.mongoService.removeDatabase(serverName, mongoInfo.databaseName!)) {
            // update parent node
            await mongoObjectExplorer.updateNode(
              objectExplorerContext.connectionProfile.id,
              objectExplorerContext.connectionProfile.serverName
            );
            vscode.window.showInformationMessage(
              localize("successDeleteDatabase", "Successfully deleted database {0}", mongoInfo.databaseName)
            );
          } else {
            vscode.window.showErrorMessage(
              localize("failedDeleteDatabase", "Failed to delete database {0}", mongoInfo.databaseName)
            );
          }
        } catch (e) {
          vscode.window.showErrorMessage(
            `${localize("failedDeleteDatabase", "Failed to delete database {0}", mongoInfo.databaseName)}: ${e}`
          );
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "cosmosdb-ads-extension.deleteMongoCollection",
      async (objectExplorerContext: azdata.ObjectExplorerContext) => {
        if (!objectExplorerContext.connectionProfile) {
          // TODO handle error;
          vscode.window.showErrorMessage(localize("missingConnectionProfile", "Missing ConnectionProfile"));
          return;
        }
        const { id: connectionId, serverName } = objectExplorerContext.connectionProfile;

        // TODO FIX THIS
        if (!objectExplorerContext.nodeInfo) {
          // TODO handle error;
          vscode.window.showErrorMessage(localize("missingNodeInfo", "Missing node information"));
          return;
        }
        const { nodePath } = objectExplorerContext.nodeInfo;
        const mongoInfo = getNodeInfo(nodePath);

        const response = await vscode.window.showInputBox({
          placeHolder: localize("removeCollectionConfirm", "Please enter the name of the collection to delete"),
        });

        if (response !== mongoInfo.collectionName) {
          vscode.window.showErrorMessage(
            localize(
              "incorrectDeleteCollection",
              "Incorrect name supplied to delete collection {0}",
              mongoInfo.collectionName
            )
          );
          return;
        }

        try {
          if (
            await appContext.mongoService.removeCollection(
              serverName,
              mongoInfo.databaseName!,
              mongoInfo.collectionName!
            )
          ) {
            // Find parent node to update
            const { serverName, databaseName } = getNodeInfo(objectExplorerContext.nodeInfo.nodePath);
            const newNodePath = createNodePath(serverName, databaseName);
            await mongoObjectExplorer.updateNode(objectExplorerContext.connectionProfile.id, newNodePath);
            vscode.window.showInformationMessage(
              localize("successDeleteCollection", "Successfully deleted collection {0}", mongoInfo.collectionName)
            );
          } else {
            vscode.window.showErrorMessage(
              localize("failDeleteCollection", "Failed to delete collection {0}", mongoInfo.collectionName)
            );
          }
        } catch (e) {
          vscode.window.showErrorMessage(
            `${localize("failDeleteCollection", "Failed to delete collection {0}:", mongoInfo.collectionName)}: ${e}`
          );
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "cosmosdb-ads-extension.openMongoDatabaseDashboard",
      (objectExplorerContext: azdata.ObjectExplorerContext, databaseDashboardInfo?: IDatabaseDashboardInfo) => {
        if (objectExplorerContext?.connectionProfile) {
          // Called from menu tree item context menu

          if (!objectExplorerContext.nodeInfo) {
            // TODO handle error;
            vscode.window.showErrorMessage(localize("missingNodeInfo", "Missing node information"));
            return;
          }

          const nodeInfo = getNodeInfo(objectExplorerContext.nodeInfo.nodePath);
          const connectionProfile = objectExplorerContext.connectionProfile;
          databaseDashboardInfo = {
            databaseName: nodeInfo.databaseName,
            connectionId: connectionProfile.id,
            ...convertToConnectionOptions(connectionProfile),
          };
        } else {
          // Called from extension code
          if (!databaseDashboardInfo) {
            vscode.window.showErrorMessage(
              localize("missingConnectionProfile", "Missing ConnectionProfile or azureAccountId")
            );
            return;
          }
        }

        // TODO ask for database if databaseName not defined

        if (!databaseDashboardInfo.databaseName) {
          vscode.window.showErrorMessage(localize("missingDatabaseName", "Database not specified"));
          return;
        }

        const databaseDashboard = isAzureAuthType(databaseDashboardInfo.authenticationType)
          ? new CosmosDbMongoDatabaseDashboard(MongoProviderId, new ArmServiceMongo())
          : new NativeMongoDatabaseDashboard(MongoProviderId);
        databaseDashboard.openDatabaseDashboard(databaseDashboardInfo, appContext, context);
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "cosmosdb-ads-extension.openNoSqlDatabaseDashboard",
      (objectExplorerContext: azdata.ObjectExplorerContext, databaseDashboardInfo?: IDatabaseDashboardInfo) => {
        if (objectExplorerContext?.connectionProfile) {
          // Called from menu tree item context menu

          if (!objectExplorerContext.nodeInfo) {
            // TODO handle error;
            vscode.window.showErrorMessage(localize("missingNodeInfo", "Missing node information"));
            return;
          }

          const nodeInfo = getNodeInfo(objectExplorerContext.nodeInfo.nodePath);
          const connectionProfile = objectExplorerContext.connectionProfile;
          databaseDashboardInfo = {
            databaseName: nodeInfo.databaseName,
            connectionId: connectionProfile.id,
            ...convertToConnectionOptions(connectionProfile),
          };
        } else {
          // Called from extension code
          if (!databaseDashboardInfo) {
            vscode.window.showErrorMessage(
              localize("missingConnectionProfile", "Missing ConnectionProfile or azureAccountId")
            );
            return;
          }
        }

        // TODO ask for database if databaseName not defined

        if (!databaseDashboardInfo.databaseName) {
          vscode.window.showErrorMessage(localize("missingDatabaseName", "Database not specified"));
          return;
        }

        new CosmosDbNoSqlDatabaseDashboard(NoSqlProviderId, new ArmServiceNoSql()).openDatabaseDashboard(
          databaseDashboardInfo,
          appContext,
          context
        );
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cosmosdb-ads-extension.openCollection", (collectionName: string) => {
      // TODO implement
      vscode.window.showInformationMessage(collectionName);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "cosmosdb-ads-extension.openMongoQuery",
      async (connectionOptions?: IConnectionOptions, databaseName?: string, collectionName?: string) => {
        if (!connectionOptions || !databaseName || !collectionName) {
          // TODO FIX
          return;
        }

        // TODO Check if one already exists before opening a new one

        const view = new ViewLoader({
          extensionPath: context.extensionPath,
          title: collectionName,
          onReady: () => {
            view.sendCommand({
              type: "initialize",
              data: {
                connectionId: connectionOptions.server,
                databaseName,
                collectionName,
                paginationTpe: "offset",
                defaultQueryText: "{}",
              },
            });
          },
          onQuerySubmit: async (query: EditorUserQuery) => {
            console.log("submitquery", query);
            try {
              const queryResult = await appContext.mongoService.submitQuery(
                connectionOptions,
                databaseName,
                collectionName,
                query
              );
              console.log("query # results:", queryResult.documents.length, queryResult.offsetPagingInfo);
              view.sendCommand({
                type: "queryResult",
                data: queryResult,
              });
            } catch (e) {
              vscode.window.showErrorMessage(getErrorMessage(e));
            }
          },
        });
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "cosmosdb-ads-extension.openNoSqlQuery",
      async (connectionOptions?: IConnectionOptions, databaseName?: string, collectionName?: string) => {
        if (!connectionOptions || !databaseName || !collectionName) {
          // TODO FIX
          return;
        }

        // TODO Check if one already exists before opening a new one

        const view = new ViewLoader({
          extensionPath: context.extensionPath,
          title: collectionName,
          onReady: () => {
            view.sendCommand({
              type: "initialize",
              data: {
                connectionId: connectionOptions.server,
                databaseName,
                collectionName,
                paginationTpe: "infinite",
                defaultQueryText: "select * from c",
              },
            });
          },
          onQuerySubmit: async (query: EditorUserQuery) => {
            console.log("submitquery", query);
            try {
              const queryResult = await appContext.cosmosDbNoSqlService.submitQuery(
                connectionOptions,
                databaseName,
                collectionName,
                query
              );
              console.log("query # results:", queryResult.documents.length, queryResult.offsetPagingInfo);
              view.sendCommand({
                type: "queryResult",
                data: queryResult,
              });
            } catch (e) {
              vscode.window.showErrorMessage(getErrorMessage(e));
            }
          },
        });
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "cosmosdb-ads-extension.openMongoShell",
      async (connectionOptions?: IConnectionOptions, databaseName?: string) => {
        const serverName = connectionOptions?.server;
        if (!serverName) {
          vscode.window.showErrorMessage(localize("noServerSpecified", "No server specified"));
          return;
        }

        const terminalName = `${serverName}${databaseName ? "/" + databaseName : ""}`;

        let counter = terminalMap.get(terminalName) ?? -1;
        const isTerminalOpen = terminalMap.size > 0;
        terminalMap.set(terminalName, ++counter);

        // Download mongosh
        let executablePath;
        try {
          showStatusBarItem(localize("downloadingMongoShell", "Downloading mongo shell..."));
          executablePath = await downloadMongoShell(context.extensionPath);
          hideStatusBarItem();
        } catch (e) {
          if (!executablePath) {
            vscode.window.showErrorMessage(
              `${localize("failInstallMongoShell", "Unable to install mongo shell")}: ${e}`
            );
            return;
          }
        }

        if (!executablePath) {
          vscode.window.showErrorMessage(localize("failInstallMongoShell", "Unable to install mongo shell"));
          return;
        }
        const mongoShellOptions = await appContext.mongoService.getMongoShellOptions(connectionOptions);

        const terminalOptions: vscode.TerminalOptions = {
          name: `Mongo Shell: ${terminalName}-${counter}`,
          shellPath: executablePath,
          isTransient: true,
        };
        if (mongoShellOptions) {
          terminalOptions.shellArgs = undefined;
          if (mongoShellOptions.connectionString !== undefined) {
            terminalOptions.shellArgs = [mongoShellOptions.connectionString];
          } else if (mongoShellOptions.connectionInfo !== undefined) {
            terminalOptions.shellArgs = ["--host", mongoShellOptions.connectionInfo.hostname];
            if (mongoShellOptions.connectionInfo.port) {
              terminalOptions.shellArgs.push("--port", mongoShellOptions.connectionInfo.port);
            }

            if (mongoShellOptions.connectionInfo.username) {
              terminalOptions.shellArgs.push("--username", mongoShellOptions.connectionInfo.username);
            }

            if (mongoShellOptions.connectionInfo.password) {
              terminalOptions.shellArgs.push("--password", mongoShellOptions.connectionInfo.password);
            }
          }

          if (mongoShellOptions.isCosmosDB && terminalOptions.shellArgs !== undefined) {
            terminalOptions.shellArgs.push("--tls", "--tlsAllowInvalidCertificates");
          }
        }

        const terminal = vscode.window.createTerminal(terminalOptions);
        context.subscriptions.push(terminal);
        vscode.window.onDidCloseTerminal((t: vscode.Terminal) => {
          if (t === terminal && t.exitStatus !== undefined) {
            terminalMap.delete(serverName);
          }
        });

        if (databaseName !== undefined) {
          terminal.sendText(`use ${databaseName}\n`);
        }
        terminal.show();

        if (!isTerminalOpen) {
          // Wait for it to settle, then make terminal bigger on first mongoshell
          // TODO: Consider maximize? "workbench.action.toggleMaximizedPanel"
          setTimeout(() => {
            vscode.commands.executeCommand("workbench.action.terminal.resizePaneUp");
            vscode.commands.executeCommand("workbench.action.terminal.resizePaneUp");
          }, 1000);
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cosmosdb-ads-extension.startProxy", async () => {
      console.log("Starting proxy");
      // Download mongosh
      const executablePath = "C:\\CosmosDB\\ADS\\CosmosDbProxy\\CosmosDbProxy\\bin\\Debug\\net6.0\\CosmosDbProxy.exe";
      const childProcess = cp.exec(executablePath, (err, stdout, stderr) => {
        console.log("stdout: " + stdout);
        console.log("stderr: " + stderr);
        if (err) {
          console.log("error: " + err);
        }
      });
      console.log("proxy was started", childProcess);

      // childProcess.stdin.setEncoding("utf8");
      // childProcess.stdin.on("data",)

      if (!childProcess || !childProcess.stdout || !childProcess.stderr || !childProcess.stdin) {
        console.error("Error executing", executablePath);
        return;
      }

      console.log("Listening to stdout and stderr");

      childProcess.stdout.setEncoding("utf8");
      childProcess.stdout.on("data", function (data) {
        //Here is where the output goes

        console.log("New data on stdout: " + data);

        data = data.toString();
      });

      childProcess.stderr.setEncoding("utf8");
      childProcess.stderr.on("data", function (data) {
        //Here is where the error output goes

        console.log("New data on stderr: " + data);

        data = data.toString();
      });

      childProcess.on("close", function (code) {
        //Here you can get the exit code of the script

        console.log("closing code: " + code);
      });

      console.log("Sending messages");

      childProcess.stdin.write("BLAH");
      setTimeout(() => {
        childProcess && childProcess.stdin?.write("query");
      }, 5000);

      console.log("Done");
    })
  );

  context.subscriptions.push(vscode.window.registerUriHandler(new UriHandler()));

  // create telemetry reporter on extension activation
  const packageInfo = getPackageInfo();
  const reporter = new TelemetryReporter(packageInfo.name, packageInfo.version, packageInfo.aiKey);
  // Instantiate client
  appContext = new AppContext(reporter);
  createStatusBarItem();

  const mongoConnectionProvider = new ConnectionProvider(appContext.mongoService, MongoProviderId);
  const noSqlConnectionProvider = new ConnectionProvider(appContext.cosmosDbNoSqlService, NoSqlProviderId);
  const mongoIconProvider = new MongoIconProvider();
  const noSqlIconProvider = new NoSqlIconProvider();
  const mongoObjectExplorer = new MongoObjectExplorerProvider(context, appContext.reporter, appContext.mongoService);
  const noSqlObjectExplorer = new NoSqlObjectExplorerProvider(
    context,
    appContext.reporter,
    appContext.cosmosDbNoSqlService
  );
  azdata.dataprotocol.registerConnectionProvider(mongoConnectionProvider);
  azdata.dataprotocol.registerConnectionProvider(noSqlConnectionProvider);
  azdata.dataprotocol.registerIconProvider(mongoIconProvider);
  azdata.dataprotocol.registerIconProvider(noSqlIconProvider);
  azdata.dataprotocol.registerObjectExplorerProvider(mongoObjectExplorer);
  azdata.dataprotocol.registerObjectExplorerProvider(noSqlObjectExplorer);

  registerMongoHomeDashboardTabs(context, appContext);

  // ensure it gets property disposed
  context.subscriptions.push(reporter);
}

// export let objectExplorer:azdata.ObjectExplorerProvider | undefined; // TODO should we inject this instead?

// this method is called when your extension is deactivated
export function deactivate() {}
