import {
  Action,
  ActionPanel,
  Color,
  getPreferenceValues,
  Icon,
  List,
  Keyboard,
} from "@raycast/api";
import { showFailureToast, useCachedPromise } from "@raycast/utils";
import { EnvGroup, loadEnvGroups, TailnetService } from "./railway";

interface Preferences {
  railwayApiToken: string;
  showUnrouted: boolean;
}

export default function Command() {
  const { railwayApiToken, showUnrouted } = getPreferenceValues<Preferences>();
  const { data, isLoading, error, revalidate } = useCachedPromise(
    loadEnvGroups,
    [railwayApiToken, showUnrouted],
    {
      keepPreviousData: true,
      onError: (e) => {
        showFailureToast(e, { title: "Could not load Railway services" });
      },
    },
  );

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder="Search services, projects, environments…"
    >
      {error && !data ? (
        <List.EmptyView
          icon={Icon.Warning}
          title="Could not load Railway services"
          description={error.message}
          actions={
            <ActionPanel>
              <Action
                title="Retry"
                icon={Icon.ArrowClockwise}
                onAction={revalidate}
              />
            </ActionPanel>
          }
        />
      ) : data?.length === 0 ? (
        <List.EmptyView
          icon={Icon.Network}
          title="No routed environments found"
          description={
            "No Railway environment with a tailscale-rw subnet router was detected.\n" +
            "Deploy the router (github.com/dotlouis/tailscale-rw) or enable\n" +
            "“Show environments without a Tailscale router” in the preferences."
          }
        />
      ) : (
        data?.map((group) => (
          <EnvSection key={group.key} group={group} onRefresh={revalidate} />
        ))
      )}
    </List>
  );
}

function EnvSection({
  group,
  onRefresh,
}: {
  group: EnvGroup;
  onRefresh: () => void;
}) {
  return (
    <List.Section
      title={`${group.projectName} / ${group.envName}`}
      subtitle={
        group.routerName
          ? `*.${group.suffix} via ${group.routerName}`
          : "no router detected"
      }
    >
      {group.services.map((svc) => (
        <ServiceItem
          key={svc.key}
          svc={svc}
          group={group}
          onRefresh={onRefresh}
        />
      ))}
    </List.Section>
  );
}

function ServiceItem({
  svc,
  group,
  onRefresh,
}: {
  svc: TailnetService;
  group: EnvGroup;
  onRefresh: () => void;
}) {
  const hostPort = svc.port ? `${svc.host}:${svc.port}` : svc.host;
  const browserUrl = `http://${hostPort}`;
  const reachable = !!group.routerName;

  return (
    <List.Item
      icon={{
        source: svc.isDatabase ? Icon.Coin : Icon.Globe,
        tintColor: reachable ? Color.PrimaryText : Color.SecondaryText,
      }}
      title={svc.name}
      subtitle={hostPort}
      keywords={[group.projectName, group.envName, svc.host]}
      accessories={[
        ...(svc.port
          ? []
          : [
              {
                tag: { value: "port?", color: Color.Orange },
                tooltip:
                  "Listen port unknown — no PORT variable and no known image default",
              },
            ]),
        ...(reachable
          ? []
          : [
              {
                tag: { value: "no router", color: Color.Orange },
                tooltip:
                  "No tailscale-rw service in this environment — host not reachable yet",
              },
            ]),
      ]}
      actions={
        <ActionPanel>
          <ActionPanel.Section>
            <Action.OpenInBrowser url={browserUrl} />
            <Action.CopyToClipboard title="Copy Host:Port" content={hostPort} />
            <Action.CopyToClipboard
              title="Copy Host"
              content={svc.host}
              shortcut={Keyboard.Shortcut.Common.Pin}
            />
            {svc.connectionUrl && (
              <Action.CopyToClipboard
                title="Copy Connection String"
                content={svc.connectionUrl}
                shortcut={Keyboard.Shortcut.Common.Copy}
                concealed
              />
            )}
          </ActionPanel.Section>
          <ActionPanel.Section>
            <Action.OpenInBrowser
              title="Open in Railway"
              icon={Icon.Train}
              url={`https://railway.com/project/${group.projectId}?environmentId=${group.environmentId}`}
              shortcut={Keyboard.Shortcut.Common.Open}
            />
            <Action
              title="Refresh"
              icon={Icon.ArrowClockwise}
              onAction={onRefresh}
              shortcut={Keyboard.Shortcut.Common.Refresh}
            />
          </ActionPanel.Section>
        </ActionPanel>
      }
    />
  );
}
