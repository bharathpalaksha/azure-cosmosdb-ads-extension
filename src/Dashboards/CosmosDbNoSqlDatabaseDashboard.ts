/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the Source EULA. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as azdata from "azdata";
import * as vscode from "vscode";
import * as nls from "vscode-nls";
import { AppContext } from "../appContext";
import { Telemetry } from "../constant";
import { IConnectionNodeInfo, IDatabaseDashboardInfo } from "../extension";
import { ICosmosDbCollectionInfo } from "../models";
import { AbstractArmService } from "../Services/AbstractArmService";
import { AbstractDatabaseDashboard } from "./AbstractDatabaseDashboard";
import { createNodePath } from "../Providers/objectExplorerNodeProvider";
import { buildHeroCard } from "../util";

const localize = nls.loadMessageBundle();

export class CosmosDbNoSqlDatabaseDashboard extends AbstractDatabaseDashboard {
  constructor(providerId: string, private armService: AbstractArmService) {
    super(providerId);
  }

  protected buildToolbar(
    view: azdata.ModelView,
    context: vscode.ExtensionContext,
    appContext: AppContext,
    databaseDashboardInfo: IDatabaseDashboardInfo
  ): azdata.ToolbarContainer {
    const buttons: (azdata.ButtonProperties & { onDidClick: () => void })[] = [
      {
        label: localize("newContainer", "New Container"),
        iconPath: {
          light: context.asAbsolutePath("resources/light/add-collection.svg"),
          dark: context.asAbsolutePath("resources/dark/add-collection-inverse.svg"),
        },
        onDidClick: () => {
          const param: IConnectionNodeInfo = {
            ...databaseDashboardInfo,
            nodePath: createNodePath(databaseDashboardInfo.server, databaseDashboardInfo.databaseName),
          };
          vscode.commands
            .executeCommand("cosmosdb-ads-extension.createMongoCollection", undefined, param)
            .then(() => this.refreshCollections && this.refreshCollections());
          appContext.reporter?.sendActionEvent(
            Telemetry.sources.databaseDashboard,
            Telemetry.actions.click,
            Telemetry.targets.databaseDashboard.toolbarNewCollection
          );
        },
      },
      {
        label: localize("refresh", "Refresh"),
        iconPath: {
          light: context.asAbsolutePath("resources/light/refresh.svg"),
          dark: context.asAbsolutePath("resources/dark/refresh-inverse.svg"),
        },
        onDidClick: () => {
          this.refreshCollections && this.refreshCollections();
          appContext.reporter?.sendActionEvent(
            Telemetry.sources.databaseDashboard,
            Telemetry.actions.click,
            Telemetry.targets.databaseDashboard.toolbarRefresh
          );
        },
      },
    ];
    const navElements: azdata.ButtonComponent[] = buttons.map((b) => {
      const component = view.modelBuilder.button().withProps(b).component();
      component.onDidClick(b.onDidClick);
      return component;
    });
    return view.modelBuilder
      .toolbarContainer()
      .withItems(navElements)
      .withLayout({ orientation: azdata.Orientation.Horizontal })
      .component();
  }

  protected buildWorkingWithDatabase(
    view: azdata.ModelView,
    appContext: AppContext,
    context: vscode.ExtensionContext,
    databaseDashboardInfo: IDatabaseDashboardInfo
  ): azdata.Component {
    const heroCards: azdata.ButtonComponent[] = [
      buildHeroCard(
        view,
        context.asAbsolutePath("resources/fluent/new-collection.svg"),
        localize("newContainer", "New Container"),
        localize("newContainerDescription", "Create a new container to store you data"),
        () => {
          const param: IConnectionNodeInfo = {
            ...databaseDashboardInfo,
            nodePath: createNodePath(databaseDashboardInfo.server, databaseDashboardInfo.databaseName),
          };
          vscode.commands
            .executeCommand("cosmosdb-ads-extension.createNoSqlContainer", undefined, param)
            .then(() => this.refreshCollections && this.refreshCollections());
          appContext.reporter?.sendActionEvent(
            Telemetry.sources.databaseDashboard,
            Telemetry.actions.click,
            Telemetry.targets.databaseDashboard.gettingStartedNewCollection
          );
        }
      ),
      buildHeroCard(
        view,
        context.asAbsolutePath("resources/fluent/new-collection.svg"),
        localize("importSampleData", "Import Sample Data"),
        localize("sampleCollectionDescription", "Create a new collection using one of our sample datasets"),
        () => {
          // TODO FIX!
          // ingestSampleMongoData(appContext, context, databaseDashboardInfo).then(
          //   () => this.refreshCollections && this.refreshCollections()
          // );
          appContext.reporter?.sendActionEvent(
            Telemetry.sources.databaseDashboard,
            Telemetry.actions.click,
            Telemetry.targets.databaseDashboard.gettingStartedImportSampleData
          );
        }
      ),
    ];

    const heroCardsContainer = view.modelBuilder
      .flexContainer()
      .withItems(heroCards, { flex: "0 0 auto" })
      .withLayout({ flexFlow: "row", flexWrap: "wrap" })
      .withProps({ CSSStyles: { width: "100%" } })
      .component();

    return view.modelBuilder
      .flexContainer()
      .withItems([
        view.modelBuilder
          .text()
          .withProps({
            value: localize("gettingStarted", "Getting started"),
            CSSStyles: { "font-family": "20px", "font-weight": "600" },
          })
          .component(),
        heroCardsContainer,
      ])
      .withLayout({ flexFlow: "column" })
      .withProps({
        CSSStyles: {
          padding: "10px",
        },
      })
      .component();
  }

  protected async buildCollectionsArea(
    databaseName: string,
    view: azdata.ModelView,
    context: vscode.ExtensionContext,
    appContext: AppContext,
    databaseDashboardInfo: IDatabaseDashboardInfo
  ): Promise<azdata.Component> {
    let collections: ICosmosDbCollectionInfo[];

    this.refreshCollections = () => {
      this.armService
        .retrieveCollectionsInfo(
          databaseDashboardInfo.azureAccount,
          databaseDashboardInfo.azureTenantId,
          databaseDashboardInfo.azureResourceId,
          this.armService.getAccountNameFromOptions(databaseDashboardInfo),
          databaseName
        )
        .then((collectionsInfo) => {
          collections = collectionsInfo;
          tableComponent.data = collectionsInfo.map((collection) => [
            <azdata.HyperlinkColumnCellValue>{
              title: collection.name,
              icon: context.asAbsolutePath("resources/fluent/collection.svg"),
            },
            collection.usageSizeKB === undefined ? localize("unknown", "Unknown") : collection.usageSizeKB,
            collection.documentCount === undefined ? localize("unknown", "Unknown") : collection.documentCount,
            collection.shardKey === undefined ? "" : Object.keys(collection.shardKey)[0],
            <azdata.HyperlinkColumnCellValue>{
              title: collection.throughputSetting,
            },
          ]);

          tableLoadingComponent.loading = false;
        });
    };
    this.refreshCollections();

    const tableComponent = view.modelBuilder
      .table()
      .withProps({
        columns: [
          <azdata.HyperlinkColumn>{
            value: "collection",
            type: azdata.ColumnType.hyperlink,
            name: localize("container", "Container"),
            width: 250,
          },
          {
            value: localize("dataUsage", "Data Usage (KB)"),
            type: azdata.ColumnType.text,
          },
          {
            value: localize("documents", "Documents"),
            type: azdata.ColumnType.text,
          },
          {
            value: localize("shardKey", "Shard key"), // TODO FIX
            type: azdata.ColumnType.text,
          },
          <azdata.HyperlinkColumn>{
            value: "throughput",
            type: azdata.ColumnType.hyperlink,
            name: localize("throughput", "Throughput"),
            width: 200,
          },
        ],
        data: [],
        height: 500,
        CSSStyles: {
          padding: "20px",
        },
      })
      .component();

    tableComponent.onCellAction &&
      tableComponent.onCellAction(async (arg: any /* Bug with definition: ICellActionEventArgs */) => {
        if (arg.name === "collection") {
          vscode.commands.executeCommand(
            "cosmosdb-ads-extension.openNoSqlQuery",
            { ...databaseDashboardInfo },
            databaseDashboardInfo.databaseName,
            collections[arg.row].name
          );

          appContext.reporter?.sendActionEvent(
            Telemetry.sources.databaseDashboard,
            Telemetry.actions.click,
            Telemetry.targets.databaseDashboard.collectionsListAzureOpenDashboard
          );
        } else if (arg.name === "throughput" && collections[arg.row].throughputSetting !== "") {
          try {
            const result = await this.armService.changeCollectionThroughput(
              databaseDashboardInfo.azureAccount,
              databaseDashboardInfo.azureTenantId,
              databaseDashboardInfo.azureResourceId,
              this.armService.getAccountNameFromOptions(databaseDashboardInfo),
              databaseName,
              collections[arg.row]
            );
            if (result) {
              this.refreshCollections && this.refreshCollections();
            }
            appContext.reporter?.sendActionEvent(
              Telemetry.sources.databaseDashboard,
              Telemetry.actions.click,
              Telemetry.targets.databaseDashboard.collectionsListAzureChangeThroughput
            );
          } catch (e: any) {
            vscode.window.showErrorMessage(e?.message);
          }
        }
      });

    const tableLoadingComponent = view.modelBuilder
      .loadingComponent()
      .withItem(tableComponent)
      .withProps({
        loading: true,
      })
      .component();

    return view.modelBuilder
      .flexContainer()
      .withItems([
        view.modelBuilder
          .text()
          .withProps({
            value: localize("containerOverview", "Container overview"),
            CSSStyles: { "font-size": "20px", "font-weight": "600" },
          })
          .component(),
        view.modelBuilder
          .text()
          .withProps({
            value: localize("containerOverviewDescription", "Click on a container to work with the data"),
          })
          .component(),
        tableLoadingComponent,
      ])
      .withLayout({ flexFlow: "column" })
      .withProps({ CSSStyles: { padding: "10px" } })
      .component();
  }
}
