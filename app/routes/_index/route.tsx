import type { LoaderFunctionArgs } from "react-router";
import { redirect, Form, useLoaderData } from "react-router";

import { login } from "../../shopify.server";

import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>Hikyaku Connect</h1>
        <p className={styles.text}>
          Push your Shopify orders straight into Hikyaku as delivery jobs the
          moment a customer pays.
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input className={styles.input} type="text" name="shop" />
              <span>e.g: my-shop-domain.myshopify.com</span>
            </label>
            <button className={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}
        <ul className={styles.list}>
          <li>
            <strong>Automatic.</strong> No manual re-entry — paid orders flow
            through as soon as checkout completes.
          </li>
          <li>
            <strong>Multi-tenant.</strong> Connect this store to any Hikyaku
            organisation you belong to.
          </li>
          <li>
            <strong>Secure.</strong> Your Hikyaku credentials never touch this
            app — access is granted through Hikyaku&apos;s own OAuth sign-in.
          </li>
        </ul>
      </div>
    </div>
  );
}
