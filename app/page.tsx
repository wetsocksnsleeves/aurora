import { CreateShowButton } from "@/components/shows/CreateShowButton";
import { NewTestSessionButton } from "./NewTestSessionButton";
import styles from "./page.module.css";

export default function Home() {
  return (
    <main className={styles.main}>
      <h1 className={styles.title}>Aurora</h1>
      <p className={styles.subtitle}>
        Synchronised light shows on phone screens.
      </p>
      <div className={styles.actions}>
        <CreateShowButton
          className={styles.button}
          errorClassName={styles.error}
        />
      </div>
      <NewTestSessionButton />
    </main>
  );
}
